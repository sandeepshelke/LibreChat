import type {
  TTraceCaptureNote,
  TTurnSummaryRecord,
  TTurnSummarySource,
  TResponseStats,
  TResponseStatsCall,
  TResponseStatsPage,
  TResponseStatsTool,
} from 'librechat-data-provider';
import type { TraceQuery, ResponseStatsReader } from './types';
import { TraceReadError } from './types';

type StoredSummary = {
  messageId: string;
  diagnostics: TTurnSummarySource;
};

export interface ResponseStatsStore {
  /** Every owned response with stored diagnostics, oldest first, reduced to summary fields. */
  listTurnDiagnosticSummaries(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
  }): Promise<StoredSummary[]>;
}

/** The generation still running for a conversation; `responseMessageId` is absent until it is known. */
export type LiveGeneration = { responseMessageId?: string };

export interface ResponseStatsOptions {
  /**
   * The conversation's running generation, or `null` when none runs. It is read once per request,
   * and only when a stored row is still `running`. A failed lookup fails the read rather than
   * asserting a row is live.
   */
  getLiveGeneration?: (input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
  }) => Promise<LiveGeneration | null>;
}

/** Notes that say records of the answer may be missing, whatever its calls reported. */
const LOSS_NOTES: ReadonlySet<TTraceCaptureNote> = new Set([
  'usage_missing',
  'records_truncated',
  'capture_failed',
  'models_not_captured',
  'subagents_not_captured',
  'response_unreadable',
  'process_ended',
]);

/** A reported measurement is a finite, nonnegative number; anything else counts as unreported. */
const reported = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Tokens per second from summed tokens and summed milliseconds; absent unless both are positive. */
const perSecond = (tokens: number, ms: number): number | undefined =>
  tokens > 0 && ms > 0 ? (1000 * tokens) / ms : undefined;

/** Running sums over the calls that reported a field; `n` counts them. */
type Sum = { n: number; value: number };
const add = (sum: Sum, value: number | undefined) => {
  if (value != null) {
    sum.n++;
    sum.value += value;
  }
};

type Speed = { tokens: number; ms: number };

function measure(record: TTurnSummaryRecord, prefill: Speed, decode: Speed): TResponseStatsCall {
  const { usage, timings, routing } = record;
  const input = reported(usage?.input) ? usage.input : undefined;
  const cacheRead = reported(usage?.cacheRead) ? usage.cacheRead : undefined;
  const output = reported(usage?.output) ? usage.output : undefined;
  const newTokens =
    input != null && cacheRead != null && input >= cacheRead ? input - cacheRead : undefined;
  const promptMs =
    reported(timings?.promptMs) && timings.promptMs > 0 ? timings.promptMs : undefined;
  const decodeMs =
    reported(timings?.decodeMs) && timings.decodeMs > 0 ? timings.decodeMs : undefined;
  const decodeTokens = reported(timings?.decodeTokens) ? timings.decodeTokens : undefined;
  let prefillTps: number | undefined;
  if (newTokens != null && promptMs != null) {
    prefill.tokens += newTokens;
    prefill.ms += promptMs;
    prefillTps = perSecond(newTokens, promptMs);
  }
  let decodeTps: number | undefined;
  if (decodeTokens != null && decodeMs != null) {
    decode.tokens += decodeTokens;
    decode.ms += decodeMs;
    decodeTps = perSecond(decodeTokens, decodeMs);
  }
  return {
    ...(reported(timings?.elapsedMs) && { elapsedMs: timings.elapsedMs }),
    ...(reported(routing?.queueMs) && { queueMs: routing.queueMs }),
    ...(reported(timings?.firstGenerationMs) && {
      firstGenerationMs: timings.firstGenerationMs,
      ...(timings.firstGenerationKind != null && {
        firstGenerationKind: timings.firstGenerationKind,
      }),
    }),
    ...(input != null && { input }),
    ...(cacheRead != null && { cacheRead }),
    ...(newTokens != null && { newTokens }),
    ...(output != null && { output }),
    ...(prefillTps != null && { prefillTps }),
    ...(decodeTps != null && { decodeTps }),
  };
}

/** Stored order is start order already when captured; only an older or foreign shape is sorted. */
function inOrder<T>(items: T[], times: number[], sorted: boolean): T[] {
  if (sorted) {
    return items;
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => times[a.index] - times[b.index] || a.index - b.index)
    .map(({ item }) => item);
}

const startOf = (record: TTurnSummaryRecord): number => {
  const time = Date.parse(record.startTime);
  return Number.isNaN(time) ? 0 : time;
};

/**
 * One answer's figures from its stored snapshot, in a single pass over its records. Both speeds
 * divide a sum of tokens by a sum of milliseconds over the calls that reported every field the
 * speed needs; per-call speeds are never averaged. Title and summary calls are kept out of every
 * figure. `settled` marks a stored `running` snapshot that no generation owns.
 */
export function summarizeTurn(
  row: StoredSummary,
  showToolNames: boolean,
  settled = false,
): TResponseStats | null {
  const { diagnostics } = row;
  if (
    diagnostics?.version !== 1 ||
    diagnostics.turn?.messageId !== row.messageId ||
    !Array.isArray(diagnostics.records)
  ) {
    return null;
  }
  const { turn } = diagnostics;
  const calls: TResponseStatsCall[] = [];
  const tools: TResponseStatsTool[] = [];
  const callTimes: number[] = [];
  const toolTimes: number[] = [];
  let callsSorted = true;
  let toolsSorted = true;
  const input: Sum = { n: 0, value: 0 };
  const cacheRead: Sum = { n: 0, value: 0 };
  const output: Sum = { n: 0, value: 0 };
  const prefill: Speed = { tokens: 0, ms: 0 };
  const decode: Speed = { tokens: 0, ms: 0 };

  for (const record of diagnostics.records) {
    if (record.messageId !== row.messageId || record.traceId !== row.messageId) {
      continue;
    }
    const time = startOf(record);
    if (record.kind === 'generation' && record.origin == null) {
      const call = measure(record, prefill, decode);
      add(input, call.input);
      add(cacheRead, call.cacheRead);
      add(output, call.output);
      callsSorted &&= callTimes.length === 0 || callTimes[callTimes.length - 1] <= time;
      calls.push(call);
      callTimes.push(time);
    } else if (record.kind === 'tool') {
      const elapsedMs = record.timings?.elapsedMs;
      toolsSorted &&= toolTimes.length === 0 || toolTimes[toolTimes.length - 1] <= time;
      tools.push({
        ...(showToolNames &&
          typeof record.name === 'string' &&
          record.name !== '' && {
            name: record.name,
          }),
        ...(reported(elapsedMs) && { elapsedMs }),
      });
      toolTimes.push(time);
    }
  }

  const prefillTps = perSecond(prefill.tokens, prefill.ms);
  const decodeTps = perSecond(decode.tokens, decode.ms);
  const { elapsedMs } = turn;
  const interrupted = settled || turn.state === 'running';
  const lossy =
    (turn.state !== 'running' && turn.complete === false) ||
    (turn.droppedRecords ?? 0) > 0 ||
    (Array.isArray(turn.notes) && turn.notes.some((note) => LOSS_NOTES.has(note)));

  return {
    messageId: row.messageId,
    state: settled || turn.state === 'running' ? 'interrupted' : turn.state,
    ...(reported(elapsedMs) && { elapsedMs }),
    modelCalls: calls.length,
    toolCalls: tools.length,
    ...(input.n > 0 && { input: input.value }),
    ...(cacheRead.n > 0 && { cacheRead: cacheRead.value }),
    ...(output.n > 0 && { output: output.value }),
    ...(prefillTps != null && { prefillTps }),
    ...(decodeTps != null && { decodeTps }),
    partial:
      lossy ||
      interrupted ||
      input.n < calls.length ||
      output.n < calls.length ||
      (cacheRead.n > 0 && cacheRead.n < input.n),
    calls: inOrder(calls, callTimes, callsSorted),
    tools: inOrder(tools, toolTimes, toolsSorted),
  };
}

/**
 * Reads every saved answer's summary of one conversation in a single store query. A snapshot
 * still `running` that no live generation owns is shown as interrupted; one that is live is
 * left out, since a running answer shows no line. Ownership is read once for all rows.
 */
export function createLocalResponseStatsReader(
  store: ResponseStatsStore,
  options: ResponseStatsOptions = {},
): ResponseStatsReader {
  async function listResponseStats(query: TraceQuery): Promise<TResponseStatsPage> {
    let rows: StoredSummary[];
    try {
      rows = await store.listTurnDiagnosticSummaries({
        user: query.userId,
        conversationId: query.conversationId,
        tenantId: query.tenantId,
      });
    } catch {
      throw new TraceReadError('upstream_error', 'Local diagnostics could not be read');
    }
    const { getLiveGeneration } = options;
    let live: LiveGeneration | null | undefined;
    const summaries: TResponseStats[] = [];
    for (const row of rows) {
      let settled = false;
      if (row.diagnostics?.turn?.state === 'running') {
        if (getLiveGeneration == null) {
          continue;
        }
        if (live === undefined) {
          try {
            live = await getLiveGeneration({
              userId: query.userId,
              tenantId: query.tenantId,
              conversationId: query.conversationId,
            });
          } catch {
            throw new TraceReadError('upstream_error', 'Generation status could not be read');
          }
        }
        if (
          live != null &&
          (live.responseMessageId == null || live.responseMessageId === row.messageId)
        ) {
          continue;
        }
        settled = true;
      }
      const summary = summarizeTurn(row, query.settings.showToolNames, settled);
      if (summary != null) {
        summaries.push(summary);
      }
    }
    return { summaries };
  }

  return { listResponseStats };
}
