import type {
  TTraceRecord,
  TTraceTimings,
  TTraceOutcome,
  TTraceCaptureNote,
  TTraceTurnSummary,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

/** A turn's totals over the records it kept. A metric is `undefined` when no record reported it. */
export type TurnTotals = {
  modelCalls: number;
  toolCalls: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  /** Title and summary calls, kept out of every other figure of the answer. */
  auxiliaryCalls: number;
  /** Some model attempt reported no input or no output, so the sums may undercount. */
  partial: boolean;
};

const sum = (values: Array<number | undefined>): number | undefined => {
  const present = values.filter((value): value is number => value != null);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : undefined;
};

export function totalsOf(records: TTraceRecord[]): TurnTotals {
  const models = records.filter((record) => record.kind === 'generation' && record.origin == null);
  return {
    modelCalls: models.length,
    auxiliaryCalls: records.filter(
      (record) => record.kind === 'generation' && record.origin != null,
    ).length,
    toolCalls: records.filter((record) => record.kind === 'tool').length,
    input: sum(models.map((record) => record.usage?.input)),
    output: sum(models.map((record) => record.usage?.output)),
    cacheRead: sum(models.map((record) => record.usage?.cacheRead)),
    partial: models.some((record) => record.usage?.input == null || record.usage.output == null),
  };
}

/** Generated tokens per second of decoding, only when the provider reported both. */
export function decodeSpeed(timings?: TTraceTimings): number | undefined {
  if (timings?.decodeMs == null || timings.decodeTokens == null || timings.decodeMs <= 0) {
    return undefined;
  }
  return timings.decodeTokens / (timings.decodeMs / 1000);
}

export const OUTCOME_LABEL: Record<TTraceOutcome | 'running', TranslationKeys> = {
  running: 'com_ui_trace_outcome_running',
  completed: 'com_ui_trace_outcome_completed',
  failed: 'com_ui_trace_outcome_failed',
  cancelled: 'com_ui_trace_outcome_cancelled',
  paused: 'com_ui_trace_outcome_paused',
  interrupted: 'com_ui_trace_outcome_interrupted',
  incomplete: 'com_ui_trace_outcome_incomplete',
};

export const NOTE_LABEL: Record<TTraceCaptureNote, TranslationKeys> = {
  records_truncated: 'com_ui_trace_note_records_truncated',
  capture_failed: 'com_ui_trace_note_capture_failed',
  usage_missing: 'com_ui_trace_note_usage_missing',
  models_not_captured: 'com_ui_trace_note_models_not_captured',
  process_ended: 'com_ui_trace_note_process_ended',
  response_unreadable: 'com_ui_trace_note_response_unreadable',
  subagents_not_captured: 'com_ui_trace_note_subagents_not_captured',
  router_header_invalid: 'com_ui_trace_note_router_header_invalid',
};

export const FIRST_GENERATION_LABEL = {
  text: 'com_ui_trace_first_generation_text',
  reasoning: 'com_ui_trace_first_generation_reasoning',
  tool_call: 'com_ui_trace_first_generation_tool_call',
} as const satisfies Record<string, TranslationKeys>;

export const turnStateOf = (turn: TTraceTurnSummary): TTraceOutcome | 'running' => turn.state;
