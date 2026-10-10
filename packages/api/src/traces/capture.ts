import { performance } from 'perf_hooks';
import type {
  TTraceRecord,
  TTraceOutcome,
  TTurnDiagnostics,
  TTraceCaptureNote,
  TTraceTurnSummary,
} from 'librechat-data-provider';
import type { ResponseMeter } from './meter';
import { createResponseMeter, normalizeUsage } from './meter';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Model calls the diagnostics layer can tell apart from the answer's own calls. */
export type ModelOrigin = 'title' | 'summarization';

/** Terminal states a snapshot can be taken in; `running` is the state while the run is live. */
export type TurnSnapshotState = TTraceOutcome | 'running';

type Logger = { warn: (message: string, meta?: Record<string, unknown>) => void };

export interface TurnDiagnosticsOptions {
  /** The response message id when already known; otherwise bound before the run starts. */
  messageId?: string;
  /** Model and tool records kept for the turn; later ones are counted in `droppedRecords`. */
  maxRecords: number;
  logger?: Logger;
  /** Monotonic milliseconds. Injected for tests. */
  now?: () => number;
  /** Wall-clock epoch milliseconds, used only to place records on a timeline. */
  wall?: () => number;
}

export type ToolPreparation = { id?: string; toolCallId?: string; observed_at?: number };
export type ToolDispatch = {
  dispatched_at?: number;
  toolCalls?: Array<{ id: string; name?: string; stepId?: string }>;
};
export type ToolCompletion = {
  result?: {
    id?: string;
    completed_at?: number;
    tool_call?: { id?: string; name?: string };
  };
};
export type ToolEndSignal = { output?: { tool_call_id?: unknown; status?: unknown } };
export type ToolClosure = { id?: string; status?: string };
export type ToolFailure = { id?: string; name?: string; error?: unknown };

export interface ToolObserver {
  prepared(marker: ToolPreparation): void;
  dispatched(event: ToolDispatch): void;
  completed(event: ToolCompletion): void;
  /** The SDK's tool result, whose `status: 'error'` marks a result that did not throw. */
  ended(data: ToolEndSignal | undefined): void;
  closed(event: ToolClosure): void;
  failed(failure: ToolFailure): void;
}

export interface ModelCallContext {
  /** The configured logical model, never read from a request body. */
  model?: string;
  agentId?: string;
  /** Set for calls that are not part of the answer; they never count toward its totals. */
  origin?: ModelOrigin;
}

export interface TurnDiagnostics {
  wrapFetch(base: FetchLike | undefined, context?: ModelCallContext): FetchLike;
  readonly tools: ToolObserver;
  /** Sets the server-owned response message id; ignored once set. */
  bindMessage(messageId: string): void;
  /** Continues the stored diagnostics of an earlier segment of this turn (a resumed approval). */
  seed(prior: TTurnDiagnostics | null | undefined): void;
  /** A model call went through a provider path this layer cannot see into. */
  noteModelsNotCaptured(): void;
  /** Records a capture limitation observed while the turn ran. */
  note(note: TTraceCaptureNote): void;
  /** Holds a limitation back until the named event happens, so an idle path never taints a turn. */
  armNote(trigger: string, note: TTraceCaptureNote): void;
  fireNote(trigger: string): void;
  /** The terminal state last snapshotted, once a snapshot was taken for a finished turn. */
  settled(): { state: TurnSnapshotState; messageId?: string } | undefined;
  /** Never throws; a failing capture reports itself in the snapshot's notes. */
  snapshot(state: TurnSnapshotState, asMessageId?: string): TTurnDiagnostics;
}

type ModelState = {
  id: string;
  /** Tool-call ids whose results this request carried; the only proof of a model's ancestry. */
  toolDeps: string[];
  origin?: ModelOrigin;
  startWall: number;
  startMono: number;
  model?: string;
  agentId?: string;
  attempt?: number;
  meter?: ResponseMeter;
  endMono?: number;
  outcome?: TTraceOutcome;
  errorCode?: string;
  httpStatus?: number;
  backend?: string;
  queueMs?: number;
  finishedUsage?: ReturnType<typeof normalizeUsage>;
  firstGenerationMs?: number;
  firstGenerationKind?: 'text' | 'reasoning' | 'tool_call';
};

type ToolState = {
  id: string;
  toolCallId: string;
  stepId?: string;
  name?: string;
  preparedWall?: number;
  dispatchWall?: number;
  dispatchMono?: number;
  completedWall?: number;
  completedMono?: number;
  outcome?: TTraceOutcome;
  errorCode?: string;
  /** Rebuilt from a previous segment's snapshot; transitions in place when it resumes. */
  seeded?: TTraceRecord;
};

const ROUTER_QUEUE_PATTERN = /^\d{1,9}(\.\d{1,3})?$/;
const ROUTER_BACKEND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ID_LENGTH = 200;

const validEpoch = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e14;

const iso = (epochMs: number): string => new Date(epochMs).toISOString();
const boundedMs = (value: number): number => Math.max(0, Math.round(value * 1000) / 1000);

function statusOf(outcome: TTraceOutcome | undefined, open: boolean): TTraceRecord['status'] {
  if (open || outcome == null) {
    return 'running';
  }
  if (outcome === 'completed') {
    return 'ok';
  }
  return outcome === 'failed' ? 'error' : 'warning';
}

function classifyHttp(status: number): string {
  if (status === 429) {
    return 'rate_limited';
  }
  if (status === 408 || status === 504) {
    return 'timeout';
  }
  return status >= 500 ? 'upstream_error' : 'request_rejected';
}

/** Names the failure class from the error's own type, never its message. */
export function classifyError(error: unknown, aborted: boolean): string {
  if (aborted) {
    return 'aborted';
  }
  const name = error instanceof Error ? error.name : '';
  const code =
    typeof (error as { code?: unknown } | null)?.code === 'string'
      ? String((error as { code: string }).code)
      : '';
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const causeCode = typeof cause?.code === 'string' ? cause.code : '';
  const joined = `${name} ${code} ${causeCode}`;
  if (/Abort/i.test(name)) {
    return 'aborted';
  }
  if (/Timeout|ETIMEDOUT/i.test(joined)) {
    return 'timeout';
  }
  if (/ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|TypeError/i.test(joined)) {
    return 'network_error';
  }
  return 'unknown_error';
}

/** Re-attributes a snapshot to another row, e.g. the failed-turn row that stands in for the response. */
function rekey(snapshot: TTurnDiagnostics, from: string, to: string | undefined): TTurnDiagnostics {
  if (to == null || to === '' || to === from) {
    return snapshot;
  }
  const swap = (value: string): string =>
    value.startsWith(from) ? `${to}${value.slice(from.length)}` : value;
  return {
    ...snapshot,
    turn: { ...snapshot.turn, messageId: to },
    records: snapshot.records.map((record) => ({
      ...record,
      id: swap(record.id),
      traceId: to,
      messageId: to,
      parentId: record.parentId != null ? swap(record.parentId) : record.parentId,
      ...(record.dependsOn != null && { dependsOn: record.dependsOn.map(swap) }),
    })),
  };
}

const safeId = (value: string, max = MAX_ID_LENGTH): string => value.slice(0, max);

const MAX_DEPENDENCY_BODY_CHARS = 16_000_000;
const MAX_DEPENDENCIES = 64;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * The tool-call ids a request carries results for: tool messages after the last assistant
 * message (chat completions) or `function_call_output` items after the last message (Responses).
 * Only ids are kept; the body is parsed transiently and never retained.
 */
export function toolResultIds(body: unknown): string[] {
  if (typeof body !== 'string' || body.length > MAX_DEPENDENCY_BODY_CHARS) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!isObject(parsed)) {
    return [];
  }
  const ids: string[] = [];
  const add = (value: unknown) => {
    if (
      typeof value === 'string' &&
      value !== '' &&
      value.length <= MAX_ID_LENGTH &&
      !ids.includes(value) &&
      ids.length < MAX_DEPENDENCIES
    ) {
      ids.push(value);
    }
  };
  if (Array.isArray(parsed.messages)) {
    const items = parsed.messages as unknown[];
    let from = 0;
    items.forEach((item, index) => {
      if (isObject(item) && item.role === 'assistant') {
        from = index + 1;
      }
    });
    for (const item of items.slice(from)) {
      if (isObject(item) && item.role === 'tool') {
        add(item.tool_call_id);
      }
    }
  } else if (Array.isArray(parsed.input)) {
    const items = parsed.input as unknown[];
    let from = 0;
    items.forEach((item, index) => {
      const type = isObject(item) ? item.type : undefined;
      if (type !== 'function_call' && type !== 'function_call_output' && type !== 'reasoning') {
        from = index + 1;
      }
    });
    for (const item of items.slice(from)) {
      if (isObject(item) && item.type === 'function_call_output') {
        add(item.call_id);
      }
    }
  }
  return ids;
}

/** What a call that never finished is when the turn is snapshotted in `final`. */
function unfinishedOutcome(final: TurnSnapshotState): TTraceOutcome | undefined {
  if (final === 'running') {
    return undefined;
  }
  return final === 'completed' ? 'incomplete' : final;
}

export function createTurnDiagnostics(options: TurnDiagnosticsOptions): TurnDiagnostics {
  const { maxRecords, logger } = options;
  let messageId = options.messageId ?? '';
  const mono = options.now ?? (() => performance.now());
  const wall = options.wall ?? (() => Date.now());

  const models: ModelState[] = [];
  const tools = new Map<string, ToolState>();
  const toolsByStep = new Map<string, string>();
  const notes = new Set<TTraceCaptureNote>();
  const armed = new Map<string, TTraceCaptureNote>();
  let settledMono: number | undefined;
  let lastSettled: { state: TurnSnapshotState; messageId?: string } | undefined;
  const startedWall = wall();
  const startedMono = mono();
  const priorRecords: TTraceRecord[] = [];
  let priorElapsedMs = 0;
  let priorStart: string | undefined;
  let segments = 1;
  let modelSeq = 0;
  let dropped = 0;
  let failedCapture = false;

  let turnId = safeId(messageId);
  const records = () => priorRecords.length + models.length + tools.size;

  function guard<T>(action: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      failedCapture = true;
      logger?.warn('[turn-diagnostics] capture step failed', {
        action,
        turnId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return undefined;
    }
  }

  function admit(): boolean {
    if (records() >= maxRecords) {
      dropped++;
      return false;
    }
    return true;
  }

  function startModel(
    context: ModelCallContext,
    init: { retry?: unknown; body?: unknown },
  ): ModelState | undefined {
    if (!admit()) {
      return undefined;
    }
    const retry = Number(init.retry);
    const state: ModelState = {
      id: `${turnId}:s${segments}.m${++modelSeq}`.slice(0, 256),
      toolDeps: context.origin == null ? toolResultIds(init.body) : [],
      ...(context.origin != null && { origin: context.origin }),
      startWall: wall(),
      startMono: mono(),
      model: context.model,
      agentId: context.agentId,
      attempt: Number.isInteger(retry) && retry > 0 && retry < 100 ? retry + 1 : undefined,
    };
    models.push(state);
    return state;
  }

  function endModel(state: ModelState, outcome: TTraceOutcome, errorCode?: string): void {
    if (state.endMono != null) {
      return;
    }
    state.endMono = mono();
    state.outcome = outcome;
    state.errorCode = errorCode;
    const result = state.meter?.finish();
    if (result != null) {
      if (result.unreadable > 0) {
        notes.add('response_unreadable');
      }
      state.finishedUsage = normalizeUsage(result.usage, result.timings);
      if (result.firstGeneration != null) {
        state.firstGenerationMs = boundedMs(result.firstGeneration.atMs - state.startMono);
        state.firstGenerationKind = result.firstGeneration.kind;
      }
    }
  }

  function readRouterHeaders(state: ModelState, headers: Headers): void {
    const queue = headers.get('x-llm-router-queue-ms');
    if (queue != null) {
      if (ROUTER_QUEUE_PATTERN.test(queue.trim())) {
        state.queueMs = Number(queue.trim());
      } else {
        notes.add('router_header_invalid');
      }
    }
    const backend = headers.get('x-llm-router-backend');
    if (backend != null) {
      if (ROUTER_BACKEND_PATTERN.test(backend.trim())) {
        state.backend = backend.trim();
      } else {
        notes.add('router_header_invalid');
      }
    }
  }

  function observeResponse(
    state: ModelState,
    response: Response,
    signal: AbortSignal | null | undefined,
  ): Response {
    readRouterHeaders(state, response.headers);
    state.httpStatus = response.status;
    if (!response.ok) {
      endModel(state, 'failed', classifyHttp(response.status));
      return response;
    }
    if (response.body == null) {
      endModel(state, 'completed');
      return response;
    }
    state.meter = createResponseMeter({
      contentType: response.headers.get('content-type'),
      now: mono,
    });
    const reader = response.body.getReader();
    const meter = state.meter;
    const settle = (kind: 'done' | 'cancel' | 'error', error?: unknown) =>
      guard('model.end', () => {
        if (kind === 'cancel') {
          endModel(state, 'cancelled', 'aborted');
        } else if (kind === 'error') {
          const aborted = signal?.aborted === true;
          endModel(state, aborted ? 'cancelled' : 'interrupted', classifyError(error, aborted));
        } else {
          const read = meter.finish();
          const cut = read.mode !== 'other' && !read.terminated;
          if (read.errorFrame) {
            endModel(state, 'failed', 'provider_error');
          } else if (cut) {
            endModel(
              state,
              'incomplete',
              read.mode === 'sse' ? 'stream_truncated' : 'body_truncated',
            );
          } else {
            endModel(state, 'completed');
          }
        }
      });
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          settle('error', error);
          controller.error(error);
          return;
        }
        if (chunk.done) {
          settle('done');
          controller.close();
          return;
        }
        guard('model.push', () => meter.push(chunk.value));
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        settle('cancel');
        return reader.cancel(reason);
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  function wrapFetch(base: FetchLike | undefined, context: ModelCallContext = {}): FetchLike {
    const target: FetchLike = base ?? ((input, init) => fetch(input, init));
    return async (input, init) => {
      const state = guard('model.start', () =>
        startModel(context, {
          retry:
            init?.headers != null ? new Headers(init.headers).get('x-stainless-retry-count') : null,
          body: init?.body,
        }),
      );
      let response: Response;
      try {
        response = await target(input, init);
      } catch (error) {
        if (state != null) {
          const aborted = init?.signal?.aborted === true;
          guard('model.fail', () =>
            endModel(state, aborted ? 'cancelled' : 'failed', classifyError(error, aborted)),
          );
        }
        throw error;
      }
      if (state == null) {
        return response;
      }
      return (
        guard('model.observe', () => observeResponse(state, response, init?.signal)) ?? response
      );
    };
  }

  const toolFor = (toolCallId: string): ToolState => {
    let state = tools.get(toolCallId);
    if (state == null) {
      state = { id: `${turnId}:tool:${safeId(toolCallId, 120)}`.slice(0, 256), toolCallId };
      tools.set(toolCallId, state);
    }
    return state;
  };

  const toolObserver: ToolObserver = {
    prepared(marker) {
      guard('tool.prepared', () => {
        if (typeof marker.toolCallId !== 'string' || marker.toolCallId === '') {
          return;
        }
        if (!tools.has(marker.toolCallId) && !admit()) {
          return;
        }
        const state = toolFor(marker.toolCallId);
        if (typeof marker.id === 'string') {
          state.stepId = marker.id;
          toolsByStep.set(marker.id, marker.toolCallId);
        }
        if (validEpoch(marker.observed_at)) {
          state.preparedWall = Math.min(
            state.preparedWall ?? marker.observed_at,
            marker.observed_at,
          );
        }
      });
    },
    dispatched(event) {
      guard('tool.dispatched', () => {
        for (const call of event.toolCalls ?? []) {
          if (typeof call.id !== 'string' || call.id === '') {
            continue;
          }
          if (!tools.has(call.id) && !admit()) {
            continue;
          }
          const state = toolFor(call.id);
          state.name ??= call.name;
          if (typeof call.stepId === 'string') {
            state.stepId = call.stepId;
            toolsByStep.set(call.stepId, call.id);
          }
          /** A resumed call keeps its first start; only the new dispatch re-opens it. */
          state.dispatchWall = validEpoch(event.dispatched_at) ? event.dispatched_at : wall();
          state.dispatchMono = mono();
          if (state.seeded != null && state.outcome == null) {
            state.outcome = undefined;
          }
        }
      });
    },
    completed(event) {
      guard('tool.completed', () => {
        const callId = event.result?.tool_call?.id;
        if (typeof callId !== 'string' || callId === '') {
          return;
        }
        if (!tools.has(callId) && !admit()) {
          return;
        }
        const state = toolFor(callId);
        state.name ??= event.result?.tool_call?.name;
        state.completedWall = validEpoch(event.result?.completed_at)
          ? event.result.completed_at
          : wall();
        state.completedMono = mono();
        state.outcome ??= 'completed';
      });
    },
    ended(data) {
      guard('tool.ended', () => {
        const callId = data?.output?.tool_call_id;
        if (typeof callId !== 'string' || !tools.has(callId)) {
          return;
        }
        if (data?.output?.status === 'error') {
          const state = toolFor(callId);
          state.outcome = 'failed';
          state.errorCode ??= 'tool_error';
        }
      });
    },
    closed(event) {
      guard('tool.closed', () => {
        const callId = typeof event.id === 'string' ? toolsByStep.get(event.id) : undefined;
        const state = callId != null ? tools.get(callId) : undefined;
        if (state == null) {
          return;
        }
        if (event.status === 'cancelled') {
          state.outcome = 'cancelled';
          state.errorCode ??= 'aborted';
          state.completedMono ??= mono();
          state.completedWall ??= wall();
        } else if (event.status === 'failed') {
          state.outcome = 'failed';
          state.errorCode ??= 'tool_error';
          state.completedMono ??= mono();
          state.completedWall ??= wall();
        }
      });
    },
    failed(failure) {
      guard('tool.failed', () => {
        const callId = failure.id;
        if (typeof callId !== 'string' || callId === '') {
          return;
        }
        if (!tools.has(callId) && !admit()) {
          return;
        }
        const state = toolFor(callId);
        state.name ??= failure.name;
        state.outcome = 'failed';
        state.errorCode = 'tool_exception';
        state.completedMono ??= mono();
        state.completedWall ??= wall();
      });
    },
  };

  function seed(prior: TTurnDiagnostics | null | undefined): void {
    guard('seed', () => {
      if (prior == null || prior.version !== 1 || prior.turn.messageId !== messageId) {
        return;
      }
      segments = prior.turn.segments + 1;
      priorElapsedMs = prior.turn.elapsedMs ?? 0;
      priorStart = prior.turn.startTime;
      dropped = prior.turn.droppedRecords ?? 0;
      for (const note of prior.turn.notes) {
        notes.add(note);
      }
      /** A paused tool continues in place on resume; everything else is history. */
      for (const record of prior.records) {
        if (record.kind === 'tool' && record.outcome === 'paused' && record.toolCallId != null) {
          const state = toolFor(record.toolCallId);
          state.seeded = record;
          state.name = record.name;
          state.id = record.id;
          state.preparedWall =
            record.preparedTime != null ? Date.parse(record.preparedTime) : undefined;
          state.dispatchWall = Date.parse(record.startTime);
          state.outcome = undefined;
        } else {
          priorRecords.push(record);
        }
      }
      for (const record of prior.records) {
        if (record.kind === 'tool' && record.outcome === 'completed' && record.toolCallId != null) {
          const state = toolFor(record.toolCallId);
          state.id = record.id;
          state.seeded = record;
        }
      }
    });
  }

  function modelRecord(state: ModelState, final: TurnSnapshotState): TTraceRecord {
    const open = state.endMono == null;
    const outcome: TTraceOutcome | undefined = open ? unfinishedOutcome(final) : state.outcome;
    const elapsed = boundedMs((state.endMono ?? mono()) - state.startMono);
    const usage =
      state.finishedUsage ??
      (state.meter
        ? normalizeUsage(state.meter.peek().usage, state.meter.peek().timings)
        : undefined);
    const record: TTraceRecord = {
      id: state.id,
      traceId: turnId,
      messageId,
      parentId: null,
      kind: 'generation',
      role: 'model',
      name: state.model ?? 'model',
      ...(state.model != null && { model: state.model }),
      startTime: iso(state.startWall),
      ...(outcome != null && { endTime: iso(state.startWall + elapsed) }),
      status: statusOf(outcome, outcome == null),
      source: 'local',
      ...(outcome != null && { outcome }),
      ...(state.errorCode != null && { errorCode: state.errorCode }),
      ...(state.httpStatus != null && { httpStatus: state.httpStatus }),
      ...(state.agentId != null && { agentId: state.agentId }),
      ...(state.origin != null && { origin: state.origin }),
      ...(state.attempt != null && { attempt: state.attempt }),
    };
    if (state.backend != null || state.queueMs != null) {
      record.routing = {
        ...(state.backend != null && { backend: state.backend }),
        ...(state.queueMs != null && { queueMs: state.queueMs }),
      };
    }
    if (outcome != null) {
      record.timings = {
        elapsedMs: elapsed,
        ...(state.firstGenerationMs != null && {
          firstGenerationMs: state.firstGenerationMs,
          firstGenerationKind: state.firstGenerationKind,
        }),
        ...(usage?.promptMs != null && { promptMs: usage.promptMs }),
        ...(usage?.decodeMs != null && {
          decodeMs: usage.decodeMs,
          decodeTokens: usage.decodeTokens,
        }),
      };
      if (state.firstGenerationMs != null) {
        record.completionStartTime = iso(state.startWall + state.firstGenerationMs);
      }
    }
    if (usage != null && (usage.input != null || usage.output != null || usage.cacheRead != null)) {
      record.usage = {
        ...(usage.input != null && { input: usage.input }),
        ...(usage.output != null && { output: usage.output }),
        ...(usage.cacheRead != null && { cacheRead: usage.cacheRead }),
        ...(usage.reasoning != null && { reasoning: usage.reasoning }),
        ...(usage.input != null && usage.output != null && { total: usage.input + usage.output }),
      };
    }
    return record;
  }

  /** A tool's parent is the model call whose stream emitted its id; nothing else proves it. */
  function parentOfTool(state: ModelState[], tool: ToolState): string | null {
    return (
      state.find((model) => model.meter?.peek().toolCallIds.includes(tool.toolCallId))?.id ?? null
    );
  }

  function toolRecord(state: ToolState, final: TurnSnapshotState): TTraceRecord {
    const started = state.dispatchWall ?? state.preparedWall ?? state.completedWall ?? wall();
    const finished = state.completedWall != null;
    const outcome: TTraceOutcome | undefined =
      state.outcome ?? (finished ? 'completed' : unfinishedOutcome(final));
    /** Only the process's monotonic clock inside one segment can measure a duration. */
    const elapsed =
      state.dispatchMono != null &&
      state.completedMono != null &&
      state.completedMono >= state.dispatchMono
        ? boundedMs(state.completedMono - state.dispatchMono)
        : undefined;
    const parentId = state.seeded?.parentId ?? parentOfTool(models, state);
    const record: TTraceRecord = {
      id: state.id,
      traceId: turnId,
      messageId,
      parentId,
      kind: 'tool',
      name: state.name ?? 'tool',
      startTime: iso(started),
      ...(elapsed != null && { endTime: iso(started + elapsed) }),
      status: statusOf(outcome, outcome == null),
      source: 'local',
      toolCallId: state.toolCallId,
      ...(outcome != null && { outcome }),
      ...(state.errorCode != null && { errorCode: state.errorCode }),
      ...(state.preparedWall != null && { preparedTime: iso(state.preparedWall) }),
      ...(state.dispatchWall != null && { dispatchTime: iso(state.dispatchWall) }),
    };
    if (elapsed != null) {
      record.timings = { elapsedMs: elapsed };
    }
    return record;
  }

  return {
    wrapFetch,
    tools: toolObserver,
    bindMessage(id) {
      if (messageId === '' && typeof id === 'string' && id !== '') {
        messageId = id;
        turnId = safeId(id);
      }
    },
    seed,
    noteModelsNotCaptured() {
      notes.add('models_not_captured');
    },
    note(note) {
      notes.add(note);
    },
    armNote(trigger, note) {
      armed.set(trigger, note);
    },
    fireNote(trigger) {
      const note = armed.get(trigger);
      if (note != null) {
        notes.add(note);
      }
    },
    settled: () => lastSettled,
    snapshot(state, asMessageId) {
      lastSettled = state === 'running' ? undefined : { state, messageId: asMessageId };
      const built = guard('snapshot', () => {
        const toolRecordId = new Map<string, string>();
        for (const record of priorRecords) {
          if (record.kind === 'tool' && record.toolCallId != null) {
            toolRecordId.set(record.toolCallId, record.id);
          }
        }
        for (const tool of tools.values()) {
          toolRecordId.set(tool.toolCallId, tool.id);
        }
        const live = [
          ...models.map((model) => {
            const record = modelRecord(model, state);
            const known = [...new Set(model.toolDeps.flatMap((id) => toolRecordId.get(id) ?? []))];
            if (known.length === 1) {
              record.parentId = known[0];
            } else if (known.length > 1) {
              record.dependsOn = known;
            }
            return record;
          }),
          ...[...tools.values()]
            .filter(
              (tool) => tool.seeded == null || tool.dispatchWall != null || tool.outcome != null,
            )
            .map((tool) => toolRecord(tool, state)),
        ];
        const replaced = new Set(live.map((record) => record.id));
        const all = [...priorRecords.filter((record) => !replaced.has(record.id)), ...live].sort(
          (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime),
        );
        const turnNotes = new Set(notes);
        if (dropped > 0) {
          turnNotes.add('records_truncated');
        }
        if (failedCapture) {
          turnNotes.add('capture_failed');
        }
        if (
          all.some(
            (record) =>
              record.kind === 'generation' &&
              record.origin == null &&
              (record.usage?.input == null || record.usage.output == null),
          )
        ) {
          turnNotes.add('usage_missing');
        }
        const loss = [
          'records_truncated',
          'capture_failed',
          'models_not_captured',
          'subagents_not_captured',
          'response_unreadable',
          'process_ended',
        ];
        const terminal =
          state === 'completed' ||
          state === 'failed' ||
          state === 'cancelled' ||
          state === 'interrupted' ||
          state === 'incomplete' ||
          state === 'paused';
        /** The turn ends when it first settles; a later snapshot (a title) must not stretch it. */
        if (terminal) {
          settledMono ??= mono();
        }
        const turnMono = settledMono ?? mono();
        const elapsedMs = boundedMs(priorElapsedMs + (turnMono - startedMono));
        const turn: TTraceTurnSummary = {
          messageId,
          state,
          startTime: priorStart ?? iso(startedWall),
          ...(state !== 'running' && { endTime: iso(startedWall + (turnMono - startedMono)) }),
          elapsedMs,
          segments,
          complete: terminal && ![...turnNotes].some((note) => loss.includes(note)),
          notes: [...turnNotes],
          ...(dropped > 0 && { droppedRecords: dropped }),
        };
        return { version: 1 as const, turn, records: all };
      });
      return rekey(
        built ?? {
          version: 1,
          turn: {
            messageId,
            state,
            startTime: iso(startedWall),
            segments,
            complete: false,
            notes: ['capture_failed'],
          },
          records: [],
        },
        messageId,
        asMessageId,
      );
    },
  };
}
