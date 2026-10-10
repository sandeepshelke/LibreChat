/**
 * Provider-neutral conversation trace contract. The server maps whatever its
 * tracing backend stores into these shapes, so the client never sees a
 * backend's field names, credentials, URL structure or API version.
 */

export type TTraceRecordKind = 'agent' | 'generation' | 'tool' | 'span' | 'event';

/**
 * What a record did in the run, in the application's own terms, so a client never reads a tracing
 * backend's span names. Absent on a record the backend did not describe: it is listed by `kind`.
 * `run` is a whole agent run, `agent` the named agent inside it, `plumbing` a wrapper that only
 * frames a model call, `model` a model call of the response, `tools` one round of tool calls, and
 * the label roles are the model calls that wrote the activity labels the chat shows while a
 * response runs.
 */
export type TTraceRecordRole =
  | 'run'
  | 'agent'
  | 'plumbing'
  | 'model'
  | 'tools'
  | 'stepLabel'
  | 'reasoningLabel'
  | 'phaseLabel';

/** `running` marks a record with no end time yet; it has a start but no duration. */
export type TTraceStatus = 'ok' | 'warning' | 'error' | 'running';

/**
 * How a record ended, when `status` cannot say it. A cancelled, interrupted or paused record is
 * never `ok`: `status` stays `warning` (or `running` while open) and this names the reason.
 */
export type TTraceOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'paused'
  | 'incomplete';

/** What the router measured for one model request; each field is absent unless it was observed. */
export type TTraceRouting = {
  /** Safe configured backend name, never an address. */
  backend?: string;
  /** Router pool-acquire wait in milliseconds, not total HTTP time. */
  queueMs?: number;
};

/**
 * Measured durations of one model request. Each is the measuring process's own monotonic
 * duration in milliseconds; a field that was not observed is absent, never zero.
 */
export type TTraceTimings = {
  /** Physical request start to body completion, error or cancellation. */
  elapsedMs?: number;
  /** Request start to the first nonempty generated delta; see `firstGenerationKind`. */
  firstGenerationMs?: number;
  firstGenerationKind?: 'text' | 'reasoning' | 'tool_call';
  /** Provider-reported prompt processing time. */
  promptMs?: number;
  /** Provider-reported decode time and the generated-token count it covers. */
  decodeMs?: number;
  decodeTokens?: number;
};

export type TTraceUsage = {
  input?: number;
  output?: number;
  total?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type TTraceRecord = {
  id: string;
  traceId: string;
  /** The response message whose turn produced this record; groups records into turns. */
  messageId: string;
  /** `null` for a root; may name a record that is not loaded (or does not exist). */
  parentId: string | null;
  /**
   * Other records this one is known to depend on when more than one, e.g. a model call that
   * received the results of several parallel tools; `parentId` is then `null`.
   */
  dependsOn?: string[];
  kind: TTraceRecordKind;
  role?: TTraceRecordRole;
  /** The saved agent a `role: 'agent'` record ran; absent for an agent that was never saved. */
  agentId?: string;
  /** The tools a `role: 'tools'` round called, in order, as the backend recorded the round. */
  tools?: string[];
  name: string;
  model?: string;
  /** ISO-8601 timestamps. */
  startTime: string;
  endTime?: string;
  /** First streamed token of a generation; splits its span into TTFT and decoding. */
  completionStartTime?: string;
  status: TTraceStatus;
  statusMessage?: string;
  usage?: TTraceUsage;
  /** Total cost in USD, when the backend priced the record. */
  cost?: number;
  /**
   * Set on records of the turn's title generation or context summarization; absent on the
   * response run itself. Neither counts toward the answer's totals.
   */
  origin?: 'title' | 'summarization';
  /** Present on records LibreChat captured itself; absent on records read from another backend. */
  source?: 'local';
  outcome?: TTraceOutcome;
  /** Stable machine-readable failure class; never provider or exception text. */
  errorCode?: string;
  httpStatus?: number;
  routing?: TTraceRouting;
  timings?: TTraceTimings;
  /** The framework tool-call id a `tool` record ran. */
  toolCallId?: string;
  /** 1-based physical attempt of a model call that was retried within one step. */
  attempt?: number;
  /** When the SDK handed the tool call over, and when the arguments began streaming. */
  preparedTime?: string;
  dispatchTime?: string;
};

export type TTraceCaptureNote =
  | 'records_truncated'
  | 'capture_failed'
  | 'usage_missing'
  | 'models_not_captured'
  | 'process_ended'
  | 'router_header_invalid'
  | 'response_unreadable'
  | 'subagents_not_captured';

/**
 * One response attempt as the diagnostics layer saw it. `complete` is false whenever anything the
 * turn did may be missing from its records, and `notes` says why.
 */
export type TTraceTurnSummary = {
  messageId: string;
  state: TTraceOutcome | 'running';
  startTime: string;
  endTime?: string;
  /** Accepted turn to terminal response, in the capturing process's monotonic milliseconds. */
  elapsedMs?: number;
  /** Run segments the turn took (a resumed approval adds one). */
  segments: number;
  complete: boolean;
  notes: TTraceCaptureNote[];
  /** Records the per-turn storage limit kept out. */
  droppedRecords?: number;
};

/** The metadata-only snapshot stored on an assistant message in `local` mode. */
export type TTurnDiagnostics = {
  version: 1;
  turn: TTraceTurnSummary;
  records: TTraceRecord[];
};

/** The record fields a response summary reads; the stored record has more. */
export type TTurnSummaryRecord = Pick<
  TTraceRecord,
  'messageId' | 'traceId' | 'kind' | 'origin' | 'name' | 'startTime' | 'timings'
> & {
  usage?: Pick<TTraceUsage, 'input' | 'output' | 'cacheRead'>;
  routing?: Pick<TTraceRouting, 'queueMs'>;
};

/**
 * The part of a stored snapshot a response summary reads, as the database projects it:
 * no prompts, payloads or per-record status. Not a whole {@link TTurnDiagnostics}.
 */
export type TTurnSummarySource = {
  version: 1;
  turn: Pick<
    TTraceTurnSummary,
    'messageId' | 'state' | 'elapsedMs' | 'complete' | 'notes' | 'droppedRecords'
  >;
  records: TTurnSummaryRecord[];
};

/** One answer model call, in numbers; a field nobody reported is absent. Speeds are per call. */
export type TResponseStatsCall = {
  elapsedMs?: number;
  queueMs?: number;
  firstGenerationMs?: number;
  firstGenerationKind?: 'text' | 'reasoning' | 'tool_call';
  input?: number;
  cacheRead?: number;
  /** Input the model had to process: `input - cacheRead`, only when both were reported. */
  newTokens?: number;
  output?: number;
  /** Tokens per second of prompt processing, only when every needed field was reported. */
  prefillTps?: number;
  /** Tokens per second of decoding, only when every needed field was reported. */
  decodeTps?: number;
};

/** One tool call; `name` is absent unless the deployment shows tool names. */
export type TResponseStatsTool = {
  name?: string;
  elapsedMs?: number;
};

/**
 * What one saved answer cost the model server. Totals and both speeds are computed from sums
 * over the answer's own calls (never title or summary calls); a figure no call reported is absent.
 */
export type TResponseStats = {
  messageId: string;
  state: TTraceOutcome;
  elapsedMs?: number;
  modelCalls: number;
  toolCalls: number;
  input?: number;
  cacheRead?: number;
  output?: number;
  /** Sum of `newTokens` over calls with prompt timing, per second of their summed prompt time. */
  prefillTps?: number;
  /** Sum of decode tokens over calls with decode timing, per second of their summed decode time. */
  decodeTps?: number;
  /** Some call reported no usage, so the sums may undercount. */
  partial: boolean;
  /** Answer model calls in the order they started. */
  calls: TResponseStatsCall[];
  /** Tool calls in the order they started. */
  tools: TResponseStatsTool[];
};

/** Every saved answer of a conversation that has settled diagnostics. */
export type TResponseStatsPage = {
  summaries: TResponseStats[];
};

export type TTraceErrorCode =
  | 'disabled'
  | 'not_found'
  | 'invalid_request'
  | 'rate_limited'
  | 'timeout'
  | 'unauthorized'
  | 'unsupported'
  | 'upstream_error';

export type TTraceErrorResponse = {
  error: string;
  errorCode: TTraceErrorCode;
};

export type TTraceAvailability = {
  available: boolean;
  /** Responses with stored local diagnostics, newest first and bounded; only the local reader sets it. */
  messageIds?: string[];
  /** Set when the backend cannot decide yet; ask again after this many milliseconds. */
  retryAfterMs?: number;
};

export type TTracePageParams = {
  conversationId: string;
  cursor?: string;
  /** Narrows the read to one response's turn, wherever it sits in the conversation. */
  messageId?: string;
};

export type TTraceRecordParams = {
  conversationId: string;
  recordId: string;
  /** The turn the list attributed the record to; its traces are what authorize the read. */
  messageId: string;
  /** The `sourceId` of the page that listed the record, so its detail reads the same project. */
  sourceId?: string;
};

/**
 * Newest turns first; `nextCursor` loads the next older page. A turn's records
 * may continue on the following page, and their order within a turn is not
 * defined, so a client groups records by turn and orders them by time.
 */
export type TTracePage = {
  records: TTraceRecord[];
  nextCursor?: string;
  /** Capture state of the turns whose records this page holds; only the local reader sets it. */
  turns?: TTraceTurnSummary[];
  /** Opaque identity of the backend project that served the page. */
  sourceId?: string;
};

export type TTraceContent = {
  value: string;
  truncated: boolean;
};

export type TTraceMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type TTraceToolCall = {
  name: string;
  args?: TTraceContent;
};

/** One message of a model call's conversation, each bounded on its own so a long one hides no other. */
export type TTraceMessage = {
  role: TTraceMessageRole;
  text?: TTraceContent;
  /** The tool a `tool` message answers for. */
  toolName?: string;
  /** The tools an `assistant` message asked for. */
  toolCalls?: TTraceToolCall[];
  /** Parts that are not text (an image, a file), by their type. */
  attachments?: string[];
};

/**
 * What a model call was given, as a conversation. A long one keeps its system
 * message and its newest messages, which are what the call answered, and
 * `omitted` counts the older ones left out between them.
 */
export type TTracePrompt = {
  messages: TTraceMessage[];
  /** Every message the call was given, listed or not. */
  total: number;
  omitted: number;
  /** Names of the tools the model could call. */
  tools?: string[];
};

export type TTraceRecordDetail = {
  record: TTraceRecord;
  /** False when the deployment withholds input, output and metadata. */
  contentAvailable: boolean;
  /** Set when the input is a conversation the backend could read as one; `input` stays the raw form. */
  prompt?: TTracePrompt;
  /** Set when the output is a message the backend could read as one; `output` stays the raw form. */
  reply?: TTraceMessage;
  input?: TTraceContent;
  output?: TTraceContent;
  metadata?: TTraceContent;
};

export const TRACE_CURSOR_MAX_LENGTH = 4096;
export const TRACE_SOURCE_ID_MAX_LENGTH = 128;
export const TRACE_RECORD_ID_MAX_LENGTH = 256;
