/**
 * Incremental, bounded measurement of an OpenAI-compatible response body. The meter reads the
 * bytes a transport already delivers and keeps only numeric measurements and tool-call ids; it
 * never retains generated text and never alters what the consumer receives.
 */

export type MeterUsage = {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
};

/** llama-server's extension fields: `cache_n + prompt_n` is total input, `predicted_n` is output. */
export type MeterTimings = {
  cacheN?: number;
  promptN?: number;
  predictedN?: number;
  promptMs?: number;
  predictedMs?: number;
};

export type FirstGenerationKind = 'text' | 'reasoning' | 'tool_call';

export type MeterResult = {
  mode: 'sse' | 'json' | 'other';
  usage?: MeterUsage;
  timings?: MeterTimings;
  firstGeneration?: { atMs: number; kind: FirstGenerationKind };
  toolCallIds: string[];
  finishReason?: string;
  /** The stream ended with `[DONE]` or a finish reason; absent evidence means it was cut short. */
  terminated: boolean;
  /** Events or bodies that could not be read; their measurements are missing, not zero. */
  unreadable: number;
  /** A provider error frame arrived inside a 2xx stream. */
  errorFrame: boolean;
};

export type ResponseMeter = {
  push(chunk: Uint8Array): void;
  /** The measurements so far, live; an eager tool call may name its generation before it ends. */
  peek(): MeterResult;
  /** Flushes the decoder and returns what was measured. Safe to call once the body ended or failed. */
  finish(): MeterResult;
};

const MAX_LINE_CHARS = 1_000_000;
const MAX_EVENT_CHARS = 1_000_000;
const MAX_EVENT_LINES = 256;
const MAX_PICK_CHARS = 16_384;
const MAX_TOOL_CALL_IDS = 64;
const MAX_ID_CHARS = 128;
const PICKED_KEYS = new Set(['usage', 'timings']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

export function readUsage(value: unknown): MeterUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const promptDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const completionDetails = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : {};
  const usage: MeterUsage = {
    promptTokens: count(value.prompt_tokens ?? value.input_tokens),
    completionTokens: count(value.completion_tokens ?? value.output_tokens),
    cachedTokens: count(promptDetails.cached_tokens),
    reasoningTokens: count(completionDetails.reasoning_tokens),
  };
  return Object.values(usage).some((field) => field != null) ? usage : undefined;
}

export function readTimings(value: unknown): MeterTimings | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const timings: MeterTimings = {
    cacheN: count(value.cache_n),
    promptN: count(value.prompt_n),
    predictedN: count(value.predicted_n),
    promptMs: count(value.prompt_ms),
    predictedMs: count(value.predicted_ms),
  };
  return Object.values(timings).some((field) => field != null) ? timings : undefined;
}

/**
 * Walks a JSON document one character at a time and hands back only the top-level `usage` and
 * `timings` objects, however the bytes were split. Everything else, generated text included, is
 * dropped as it is read.
 */
function createTopLevelPicker(onPicked: (key: string, value: unknown) => void) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let expectKey = false;
  let keyBuffer: string | null = null;
  let pendingKey: string | null = null;
  let armedKey: string | null = null;
  let captureKey: string | null = null;
  let capture = '';
  let captureOverflow = false;
  let rootSeen = false;

  const finishCapture = () => {
    const key = captureKey;
    captureKey = null;
    if (key == null) {
      capture = '';
      return;
    }
    if (captureOverflow) {
      captureOverflow = false;
      capture = '';
      onPicked(key, undefined);
      return;
    }
    try {
      onPicked(key, JSON.parse(capture));
    } catch {
      onPicked(key, undefined);
    }
    capture = '';
  };

  const push = (text: string) => {
    for (const char of text) {
      if (captureKey != null) {
        if (!captureOverflow) {
          capture += char;
          captureOverflow = capture.length > MAX_PICK_CHARS;
        }
      }
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
          if (keyBuffer != null) {
            pendingKey = keyBuffer;
            keyBuffer = null;
          }
        } else if (keyBuffer != null && keyBuffer.length < 32) {
          keyBuffer += char;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        keyBuffer = depth === 1 && expectKey ? '' : null;
        continue;
      }
      if (char === '{' || char === '[') {
        if (armedKey != null && depth === 1 && char === '{') {
          captureKey = armedKey;
          capture = '{';
          captureOverflow = false;
        }
        armedKey = null;
        rootSeen = true;
        depth++;
        if (depth === 1) {
          expectKey = true;
        }
        continue;
      }
      if (char === '}' || char === ']') {
        depth--;
        if (depth === 1 && captureKey != null) {
          finishCapture();
        }
        continue;
      }
      if (depth === 1) {
        if (char === ':') {
          expectKey = false;
          armedKey = pendingKey != null && PICKED_KEYS.has(pendingKey) ? pendingKey : null;
          pendingKey = null;
        } else if (char === ',') {
          expectKey = true;
          armedKey = null;
        } else if (!/\s/.test(char)) {
          armedKey = null;
        }
      }
    }
  };
  /** The document's root value was opened and closed, so the body was not cut short. */
  const closed = () => rootSeen && depth === 0 && !inString;
  return { push, closed };
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
    ? value
    : undefined;
}

export function createResponseMeter({
  contentType,
  now,
}: {
  contentType: string | null;
  /** Milliseconds on the capturing process's monotonic clock. */
  now: () => number;
}): ResponseMeter {
  const type = (contentType ?? '').toLowerCase();
  let mode: MeterResult['mode'] = 'other';
  if (type.includes('text/event-stream')) {
    mode = 'sse';
  } else if (type.includes('json')) {
    mode = 'json';
  }
  const decoder = new TextDecoder('utf-8');
  const result: MeterResult = {
    mode,
    toolCallIds: [],
    terminated: false,
    unreadable: 0,
    errorFrame: false,
  };

  let line = '';
  let dataLines: string[] = [];
  let dataChars = 0;
  let eventOverflow = false;
  let pendingCarriageReturn = false;
  let overflowing = false;
  let finished = false;

  const picker = createTopLevelPicker((key, value) => {
    if (key === 'usage') {
      result.usage = readUsage(value) ?? result.usage;
    } else {
      result.timings = readTimings(value) ?? result.timings;
    }
    if (value === undefined) {
      result.unreadable++;
    }
  });

  const noteFirst = (kind: FirstGenerationKind) => {
    result.firstGeneration ??= { atMs: now(), kind };
  };

  const readEvent = (data: string) => {
    if (data === '[DONE]') {
      result.terminated = true;
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      result.unreadable++;
      return;
    }
    if (!isRecord(event)) {
      return;
    }
    if (event.error != null) {
      result.errorFrame = true;
    }
    result.usage = readUsage(event.usage) ?? result.usage;
    result.timings = readTimings(event.timings) ?? result.timings;
    const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
    if (!isRecord(choice)) {
      return;
    }
    if (nonEmpty(choice.finish_reason)) {
      result.finishReason = String(choice.finish_reason).slice(0, 32);
      result.terminated = true;
    }
    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    if (!delta) {
      return;
    }
    if (nonEmpty(delta.reasoning_content) || nonEmpty(delta.reasoning)) {
      noteFirst('reasoning');
    }
    if (nonEmpty(delta.content)) {
      noteFirst('text');
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      for (const call of delta.tool_calls) {
        if (!isRecord(call)) {
          continue;
        }
        const fn = isRecord(call.function) ? call.function : {};
        if (nonEmpty(call.id) || nonEmpty(fn.name) || nonEmpty(fn.arguments)) {
          noteFirst('tool_call');
        }
        const id = safeId(call.id);
        if (
          id != null &&
          !result.toolCallIds.includes(id) &&
          result.toolCallIds.length < MAX_TOOL_CALL_IDS
        ) {
          result.toolCallIds.push(id);
        }
      }
    }
  };

  const flushEvent = () => {
    if (eventOverflow) {
      result.unreadable++;
    } else if (dataLines.length > 0) {
      readEvent(dataLines.join('\n'));
    }
    dataLines = [];
    dataChars = 0;
    eventOverflow = false;
  };

  const readLine = (text: string) => {
    if (text === '') {
      flushEvent();
      return;
    }
    if (eventOverflow || !text.startsWith('data:')) {
      return;
    }
    const value = text.slice(5);
    dataChars += value.length;
    if (dataLines.length >= MAX_EVENT_LINES || dataChars > MAX_EVENT_CHARS) {
      eventOverflow = true;
      dataLines = [];
      return;
    }
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
  };

  const appendLine = (piece: string) => {
    if (overflowing || piece === '') {
      return;
    }
    if (line.length + piece.length > MAX_LINE_CHARS) {
      line = '';
      overflowing = true;
      return;
    }
    line += piece;
  };

  const readText = (text: string) => {
    let input = text;
    if (pendingCarriageReturn) {
      pendingCarriageReturn = false;
      if (input.startsWith('\n')) {
        input = input.slice(1);
      }
    }
    let start = 0;
    for (let index = 0; index < input.length; index++) {
      const char = input[index];
      if (char !== '\n' && char !== '\r') {
        continue;
      }
      appendLine(input.slice(start, index));
      if (overflowing) {
        overflowing = false;
        eventOverflow = true;
        dataLines = [];
      } else {
        readLine(line);
      }
      line = '';
      if (char === '\r') {
        if (index + 1 < input.length) {
          if (input[index + 1] === '\n') {
            index++;
          }
        } else {
          pendingCarriageReturn = true;
        }
      }
      start = index + 1;
    }
    appendLine(input.slice(start));
  };

  return {
    peek: () => result,
    push(chunk) {
      const text = decoder.decode(chunk, { stream: true });
      if (mode === 'sse') {
        readText(text);
      } else if (mode === 'json') {
        picker.push(text);
      }
    },
    finish() {
      if (finished) {
        return result;
      }
      finished = true;
      const rest = decoder.decode();
      if (mode === 'sse') {
        readText(rest);
        if (overflowing) {
          eventOverflow = true;
        } else if (line.length > 0) {
          readLine(line);
        }
        flushEvent();
      } else if (mode === 'json') {
        picker.push(rest);
        if (picker.closed()) {
          result.terminated = true;
        } else {
          result.unreadable++;
        }
      }
      return result;
    },
  };
}

/** The fields that survive normalization, each present only when the provider reported it. */
export type NormalizedUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
  decodeMs?: number;
  decodeTokens?: number;
  promptMs?: number;
};

/**
 * One reading per physical request. OpenAI `usage` defines total input and output when present;
 * llama-server `timings` supplies the same totals only when `usage` is absent, and always supplies
 * the decode duration. Both are never added together.
 */
export function normalizeUsage(
  usage: MeterUsage | undefined,
  timings: MeterTimings | undefined,
): NormalizedUsage | undefined {
  const timingInput =
    timings?.promptN != null && timings.cacheN != null
      ? timings.promptN + timings.cacheN
      : undefined;
  const input = usage?.promptTokens ?? timingInput;
  const output = usage?.completionTokens ?? timings?.predictedN;
  const cacheCandidate = usage?.cachedTokens ?? timings?.cacheN;
  const cacheRead =
    cacheCandidate != null && (input == null || cacheCandidate <= input)
      ? cacheCandidate
      : undefined;
  const decodeUsable =
    timings?.predictedN != null && timings.predictedMs != null && timings.predictedMs > 0;
  const normalized: NormalizedUsage = {
    input,
    output,
    cacheRead,
    reasoning: usage?.reasoningTokens,
    decodeMs: decodeUsable ? timings.predictedMs : undefined,
    decodeTokens: decodeUsable ? timings.predictedN : undefined,
    promptMs: timings?.promptMs,
  };
  return Object.values(normalized).some((field) => field != null) ? normalized : undefined;
}
