import type {
  TTracePage,
  TTraceRecord,
  TTurnDiagnostics,
  TTraceAvailability,
  TTraceTurnSummary,
  TTraceRecordDetail,
} from 'librechat-data-provider';
import type { TraceQuery, TraceReader } from './types';
import { TraceReadError } from './types';

type StoredDiagnostics = {
  messageId: string;
  orderKey: string;
  diagnostics: TTurnDiagnostics;
};

export interface LocalTraceStore {
  listTurnDiagnostics(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    messageId?: string;
    /** Resumes older than `orderKey`, or at that response itself when `inclusive`. */
    through?: { orderKey: string; inclusive?: boolean };
    limit: number;
  }): Promise<StoredDiagnostics[]>;
  /** Every response of the conversation with stored diagnostics; bounded by the conversation. */
  listTurnDiagnosticMessageIds(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
  }): Promise<string[]>;
}

export interface LocalTraceReaderOptions {
  /**
   * Whether a live generation still owns this response. A stored `running` snapshot nothing owns
   * is reported as interrupted. A failed lookup fails the read rather than asserting it is live.
   */
  isGenerationLive?: (input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
    messageId: string;
  }) => Promise<boolean>;
}

const TURNS_PER_PAGE = 20;
const GENERIC_TOOL_NAME = 'tool';

const ORDER_KEY_PATTERN = /^[0-9a-z]{1,12}\.[0-9a-f]{24}$/;

/** `after`: continue with turns older than the key. `within`: continue inside one oversized turn. */
type LocalCursor =
  | { kind: 'after'; orderKey: string }
  | { kind: 'within'; orderKey: string; skip: number };

const encodeCursor = (cursor: LocalCursor): string =>
  Buffer.from(
    cursor.kind === 'after' ? `a:${cursor.orderKey}` : `w:${cursor.orderKey}:${cursor.skip}`,
    'utf8',
  ).toString('base64url');

function decodeCursor(cursor: string): LocalCursor {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  const [kind, orderKey, skip] = parts;
  if (orderKey == null || !ORDER_KEY_PATTERN.test(orderKey)) {
    throw new TraceReadError('invalid_request', 'Invalid cursor');
  }
  if (kind === 'a' && parts.length === 2) {
    return { kind: 'after', orderKey };
  }
  if (kind === 'w' && parts.length === 3 && /^[0-9]{1,9}$/.test(skip ?? '')) {
    return { kind: 'within', orderKey, skip: Number(skip) };
  }
  throw new TraceReadError('invalid_request', 'Invalid cursor');
}

/** A snapshot still `running` that no live generation owns ended with the process, not normally. */
export function settleAbandoned(diagnostics: TTurnDiagnostics): TTurnDiagnostics {
  const notes = diagnostics.turn.notes.includes('process_ended')
    ? diagnostics.turn.notes
    : [...diagnostics.turn.notes, 'process_ended' as const];
  return {
    ...diagnostics,
    turn: { ...diagnostics.turn, state: 'interrupted', complete: false, notes },
    records: diagnostics.records.map((record) =>
      record.status === 'running' || record.outcome == null
        ? { ...record, status: 'warning' as const, outcome: 'interrupted' as const }
        : record,
    ),
  };
}

/**
 * A stored snapshot is only trusted for what it claims about itself: its records must
 * belong to the message the row is stored under, so a forged or copied field cannot
 * surface another turn's records.
 */
function ownRecords(row: StoredDiagnostics, showToolNames: boolean): TTraceRecord[] | null {
  const { diagnostics } = row;
  if (
    diagnostics?.version !== 1 ||
    diagnostics.turn?.messageId !== row.messageId ||
    !Array.isArray(diagnostics.records)
  ) {
    return null;
  }
  return diagnostics.records
    .filter((record) => record.messageId === row.messageId && record.traceId === row.messageId)
    .map((record) => ({
      ...record,
      source: 'local' as const,
      ...(record.kind === 'tool' && !showToolNames && { name: GENERIC_TOOL_NAME }),
    }));
}

export function createLocalTraceReader(
  store: LocalTraceStore,
  options: LocalTraceReaderOptions = {},
): TraceReader {
  async function settled(query: TraceQuery, row: StoredDiagnostics): Promise<StoredDiagnostics> {
    if (row.diagnostics?.turn?.state !== 'running' || options.isGenerationLive == null) {
      return row;
    }
    try {
      const live = await options.isGenerationLive({
        userId: query.userId,
        tenantId: query.tenantId,
        conversationId: query.conversationId,
        messageId: row.messageId,
      });
      return live ? row : { ...row, diagnostics: settleAbandoned(row.diagnostics) };
    } catch {
      throw new TraceReadError('upstream_error', 'Generation status could not be read');
    }
  }

  async function isAvailable(query: TraceQuery): Promise<TTraceAvailability> {
    try {
      const messageIds = await store.listTurnDiagnosticMessageIds({
        user: query.userId,
        conversationId: query.conversationId,
        tenantId: query.tenantId,
      });
      return { available: messageIds.length > 0, messageIds };
    } catch {
      throw new TraceReadError('upstream_error', 'Local diagnostics could not be read');
    }
  }

  async function listRecords(
    query: TraceQuery & { cursor?: string; messageId?: string },
  ): Promise<TTracePage> {
    const cursor = query.cursor != null ? decodeCursor(query.cursor) : undefined;
    const focus = query.messageId;
    let rows: StoredDiagnostics[];
    try {
      rows = await store.listTurnDiagnostics({
        user: query.userId,
        conversationId: query.conversationId,
        tenantId: query.tenantId,
        ...(focus != null && { messageId: focus }),
        ...(focus == null &&
          cursor != null && {
            through: { orderKey: cursor.orderKey, inclusive: cursor.kind === 'within' },
          }),
        limit: focus != null ? 1 : TURNS_PER_PAGE + 1,
      });
    } catch {
      throw new TraceReadError('upstream_error', 'Local diagnostics could not be read');
    }
    if (cursor?.kind === 'within' && rows[0]?.orderKey !== cursor.orderKey) {
      throw new TraceReadError('invalid_request', 'Invalid cursor');
    }
    const budget = query.settings.maxRecords;
    const records: TTraceRecord[] = [];
    const turns: TTraceTurnSummary[] = [];
    let taken = 0;
    for (const stored of rows.slice(0, TURNS_PER_PAGE)) {
      const row = await settled(query, stored);
      const own = ownRecords(row, query.settings.showToolNames);
      if (own == null) {
        taken++;
        continue;
      }
      const skip = taken === 0 && cursor?.kind === 'within' ? cursor.skip : 0;
      if (skip > 0 && skip >= own.length) {
        throw new TraceReadError('invalid_request', 'Invalid cursor');
      }
      const rest = own.slice(skip);
      if (records.length > 0 && records.length + rest.length > budget) {
        break;
      }
      if (rest.length > budget) {
        records.push(...rest.slice(0, budget));
        turns.push(row.diagnostics.turn);
        return {
          records,
          turns,
          nextCursor: encodeCursor({ kind: 'within', orderKey: row.orderKey, skip: skip + budget }),
        };
      }
      records.push(...rest);
      turns.push(row.diagnostics.turn);
      taken++;
    }
    const last = rows[taken - 1];
    const more = focus == null && taken < rows.length;
    return {
      records,
      turns,
      ...(more &&
        last != null && { nextCursor: encodeCursor({ kind: 'after', orderKey: last.orderKey }) }),
    };
  }

  async function getRecord(
    query: TraceQuery & { recordId: string; messageId: string; sourceId?: string },
  ): Promise<TTraceRecordDetail | null> {
    let rows: StoredDiagnostics[];
    try {
      rows = await store.listTurnDiagnostics({
        user: query.userId,
        conversationId: query.conversationId,
        tenantId: query.tenantId,
        messageId: query.messageId,
        limit: 1,
      });
    } catch {
      throw new TraceReadError('upstream_error', 'Local diagnostics could not be read');
    }
    const row = rows[0] != null ? await settled(query, rows[0]) : undefined;
    const own = row != null ? ownRecords(row, query.settings.showToolNames) : null;
    const record = own?.find((entry) => entry.id === query.recordId);
    return record == null ? null : { record, contentAvailable: false };
  }

  return { isAvailable, listRecords, getRecord };
}

/** Picks the reader per request from the deployment's resolved `source`, so config reloads apply. */
export function createSourceTraceReader(readers: {
  local: TraceReader;
  langfuse: TraceReader;
}): TraceReader {
  const pick = (query: TraceQuery) =>
    query.settings.source === 'local' ? readers.local : readers.langfuse;
  return {
    isAvailable: (query) => pick(query).isAvailable(query),
    listRecords: (query) => pick(query).listRecords(query),
    getRecord: (query) => pick(query).getRecord(query),
  };
}
