import type {
  TTraceRecord,
  TTurnDiagnostics,
  TTurnSummarySource,
  TResolvedTraceViewerConfig,
} from 'librechat-data-provider';
import { createLocalResponseStatsReader, summarizeTurn } from './stats';
import { TraceReadError } from './types';

const settings = {
  enabled: true,
  source: 'local',
  showToolNames: true,
} as TResolvedTraceViewerConfig;
const query = { userId: 'u', conversationId: 'c', settings };

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 1, 12, 0, seconds)).toISOString();

const model = (id: string, extra: Partial<TTraceRecord> = {}): TTraceRecord => ({
  id,
  traceId: 'm1',
  messageId: 'm1',
  parentId: null,
  kind: 'generation',
  name: 'model',
  startTime: at(0),
  status: 'ok',
  ...extra,
});

const tool = (id: string, name: string, extra: Partial<TTraceRecord> = {}): TTraceRecord => ({
  id,
  traceId: 'm1',
  messageId: 'm1',
  parentId: null,
  kind: 'tool',
  name,
  startTime: at(10),
  status: 'ok',
  ...extra,
});

const turn = (
  records: TTraceRecord[],
  state: TTurnDiagnostics['turn']['state'] = 'completed',
  messageId = 'm1',
): TTurnDiagnostics => ({
  version: 1,
  turn: {
    messageId,
    state,
    startTime: at(0),
    elapsedMs: 34_100,
    segments: 1,
    complete: true,
    notes: [],
  },
  records,
});

/** Call speeds differ (250 and 428.6 prefill t/s); the sums give 410.3, an average would give 339.3. */
/** What the database returns: only the projected fields, with `notes` optionally absent. */
const projected = (
  diagnostics: TTurnDiagnostics,
  { withoutNotes = false }: { withoutNotes?: boolean } = {},
): TTurnSummarySource => ({
  version: 1,
  turn: {
    messageId: diagnostics.turn.messageId,
    state: diagnostics.turn.state,
    elapsedMs: diagnostics.turn.elapsedMs,
    complete: diagnostics.turn.complete,
    ...(!withoutNotes && { notes: diagnostics.turn.notes }),
  } as TTurnSummarySource['turn'],
  records: diagnostics.records.map(
    ({ messageId, traceId, kind, origin, name, startTime, usage, routing, timings }) => ({
      messageId,
      traceId,
      kind,
      origin,
      name,
      startTime,
      usage,
      routing,
      timings,
    }),
  ),
});

const callA = model('a', {
  startTime: at(0),
  usage: { input: 20_100, cacheRead: 19_900, output: 200 },
  routing: { queueMs: 300 },
  timings: {
    elapsedMs: 10_300,
    firstGenerationMs: 1200,
    firstGenerationKind: 'reasoning',
    promptMs: 800,
    decodeMs: 9390,
    decodeTokens: 200,
  },
});
const callB = model('b', {
  startTime: at(13),
  usage: { input: 21_100, cacheRead: 18_100, output: 612 },
  timings: { elapsedMs: 21_400, promptMs: 7000, decodeTokens: 612 },
});

describe('summarizeTurn', () => {
  it('computes both speeds from sums, never from per-call speeds', () => {
    const summary = summarizeTurn(
      {
        messageId: 'm1',
        diagnostics: turn([
          callB,
          tool('t2', 'fetch', { startTime: at(11), timings: { elapsedMs: 1900 } }),
          callA,
          tool('t1', 'search_code', { timings: { elapsedMs: 2100 } }),
        ]),
      },
      true,
    );
    expect(summary).toMatchObject({
      messageId: 'm1',
      state: 'completed',
      elapsedMs: 34_100,
      modelCalls: 2,
      toolCalls: 2,
      input: 41_200,
      cacheRead: 38_000,
      output: 812,
      partial: false,
    });
    expect(summary?.prefillTps).toBeCloseTo((1000 * 3200) / 7800, 6);
    expect(summary?.prefillTps).not.toBeCloseTo((250 + 3000 / 7) / 2, 0);
    expect(summary?.decodeTps).toBeCloseTo(21.3, 1);
    expect(summary?.calls.map((call) => call.input)).toEqual([20_100, 21_100]);
    expect(summary?.calls[0]).toMatchObject({
      queueMs: 300,
      firstGenerationKind: 'reasoning',
      newTokens: 200,
    });
    expect(summary?.calls[0].prefillTps).toBeCloseTo(250, 6);
    expect(summary?.calls[1].decodeTps).toBeUndefined();
    expect(summary?.tools).toEqual([
      { name: 'search_code', elapsedMs: 2100 },
      { name: 'fetch', elapsedMs: 1900 },
    ]);
  });

  it('divides unequal decode speeds by summed time', () => {
    const summary = summarizeTurn(
      {
        messageId: 'm1',
        diagnostics: turn([
          model('a', { timings: { decodeTokens: 100, decodeMs: 1000 } }),
          model('b', { startTime: at(1), timings: { decodeTokens: 100, decodeMs: 4000 } }),
        ]),
      },
      true,
    );
    expect(summary?.decodeTps).toBeCloseTo(200 / 5, 6);
  });

  it('leaves auxiliary calls out of every figure', () => {
    const summary = summarizeTurn(
      {
        messageId: 'm1',
        diagnostics: turn([
          callA,
          model('title', {
            origin: 'title',
            usage: { input: 900, cacheRead: 0, output: 9 },
            timings: { promptMs: 10, decodeMs: 10, decodeTokens: 9 },
          }),
          model('sum', { origin: 'summarization', usage: { input: 5, output: 5 } }),
        ]),
      },
      true,
    );
    expect(summary).toMatchObject({ modelCalls: 1, input: 20_100, output: 200, partial: false });
    expect(summary?.calls).toHaveLength(1);
  });

  it('marks a call without usage partial and omits figures nobody reported', () => {
    const summary = summarizeTurn(
      {
        messageId: 'm1',
        diagnostics: turn([callA, model('b', { startTime: at(1), timings: { elapsedMs: 500 } })]),
      },
      true,
    );
    expect(summary).toMatchObject({ modelCalls: 2, input: 20_100, partial: true });
    const bare = summarizeTurn(
      { messageId: 'm1', diagnostics: turn([model('a', { usage: { output: 7 } })]) },
      true,
    );
    expect(bare).toMatchObject({ output: 7, partial: true });
    expect(bare).not.toHaveProperty('input');
    expect(bare).not.toHaveProperty('cacheRead');
    expect(bare).not.toHaveProperty('prefillTps');
    expect(bare).not.toHaveProperty('decodeTps');
  });

  it('keeps speeds to calls that reported every needed field', () => {
    const summary = summarizeTurn(
      {
        messageId: 'm1',
        diagnostics: turn([
          model('a', { usage: { input: 1000, cacheRead: 0 }, timings: { promptMs: 500 } }),
          model('b', { startTime: at(1), usage: { input: 9000 }, timings: { promptMs: 500 } }),
          model('c', {
            startTime: at(2),
            usage: { input: 5, cacheRead: 9 },
            timings: { promptMs: 100 },
          }),
        ]),
      },
      true,
    );
    expect(summary?.prefillTps).toBeCloseTo(2000, 6);
    expect(summary?.partial).toBe(true);
  });

  it('flags cache counts that only some calls reported as partial', () => {
    const summary = summarizeTurn(
      {
        messageId: 'm1',
        diagnostics: turn([
          model('a', { usage: { input: 10, output: 1, cacheRead: 4 } }),
          model('b', { startTime: at(1), usage: { input: 10, output: 1 } }),
        ]),
      },
      true,
    );
    expect(summary).toMatchObject({ cacheRead: 4, partial: true });
  });

  it('drops tool names unless the deployment shows them', () => {
    const summary = summarizeTurn(
      {
        messageId: 'm1',
        diagnostics: turn([tool('t', 'secret_tool', { timings: { elapsedMs: 5 } })]),
      },
      false,
    );
    expect(summary?.tools).toEqual([{ elapsedMs: 5 }]);
    expect(JSON.stringify(summary)).not.toContain('secret_tool');
  });

  it('ignores forged or mismatched snapshots and invalid numbers', () => {
    expect(
      summarizeTurn({ messageId: 'other', diagnostics: turn([callA], 'completed', 'm1') }, true),
    ).toBeNull();
    const forged = summarizeTurn(
      {
        messageId: 'm1',
        diagnostics: turn([
          model('x', { messageId: 'other', traceId: 'other', usage: { input: 1 } }),
          model('n', {
            usage: { input: Number.NaN, output: -3, cacheRead: Number.POSITIVE_INFINITY },
            timings: { elapsedMs: -1, promptMs: 0, decodeMs: 0, decodeTokens: 9 },
          }),
        ]),
      },
      true,
    );
    expect(forged?.modelCalls).toBe(1);
    expect(forged?.calls[0]).toEqual({});
    expect(forged).not.toHaveProperty('input');
  });

  it.each(['records_truncated', 'subagents_not_captured', 'capture_failed'] as const)(
    'marks %s partial even when every retained call reports usage',
    (note) => {
      const diagnostics = turn([callA]);
      diagnostics.turn.notes = [note];
      diagnostics.turn.complete = false;
      expect(summarizeTurn({ messageId: 'm1', diagnostics }, true)?.partial).toBe(true);
    },
  );

  it('marks dropped records partial and a complete turn not partial', () => {
    const dropped = turn([callA]);
    dropped.turn.droppedRecords = 3;
    expect(summarizeTurn({ messageId: 'm1', diagnostics: dropped }, true)?.partial).toBe(true);
    expect(summarizeTurn({ messageId: 'm1', diagnostics: turn([callA]) }, true)?.partial).toBe(
      false,
    );
  });

  it('reads the projected shape, which omits record status and turn start', () => {
    const summary = summarizeTurn({ messageId: 'm1', diagnostics: projected(turn([callA])) }, true);
    expect(summary).toMatchObject({ state: 'completed', input: 20_100, partial: false });
  });

  it('settles a stale running snapshot from the projected shape without notes', () => {
    const diagnostics = projected(turn([callA], 'running'), { withoutNotes: true });
    expect(diagnostics.turn).not.toHaveProperty('notes');
    const summary = summarizeTurn({ messageId: 'm1', diagnostics }, true, true);
    expect(summary).toMatchObject({ state: 'interrupted', partial: true });
  });

  it('orders calls by start time only when the stored order is not already chronological', () => {
    const summary = summarizeTurn({ messageId: 'm1', diagnostics: turn([callB, callA]) }, true);
    expect(summary?.calls.map((call) => call.input)).toEqual([20_100, 21_100]);
  });
});

describe('createLocalResponseStatsReader', () => {
  const row = (messageId: string, diagnostics: TTurnDiagnostics) => ({
    messageId,
    diagnostics: projected(diagnostics),
  });
  const own = (id: string, state: TTurnDiagnostics['turn']['state'] = 'completed') =>
    turn([model('a', { traceId: id, messageId: id, usage: { input: 3, output: 1 } })], state, id);

  it('reads once, keeps paused and finished answers and skips live ones', async () => {
    const store = {
      listTurnDiagnosticSummaries: jest.fn(async () => [
        row('m1', own('m1')),
        row('m2', own('m2', 'paused')),
        row('m3', own('m3', 'running')),
      ]),
    };
    const reader = createLocalResponseStatsReader(store, {
      getLiveGeneration: async () => ({ responseMessageId: 'm3' }),
    });
    const page = await reader.listResponseStats({ ...query, tenantId: 't' });
    expect(page.summaries.map((s) => [s.messageId, s.state])).toEqual([
      ['m1', 'completed'],
      ['m2', 'paused'],
    ]);
    expect(store.listTurnDiagnosticSummaries).toHaveBeenCalledTimes(1);
    expect(store.listTurnDiagnosticSummaries).toHaveBeenCalledWith({
      user: 'u',
      conversationId: 'c',
      tenantId: 't',
    });
  });

  it('reports an abandoned running snapshot as interrupted', async () => {
    const reader = createLocalResponseStatsReader(
      { listTurnDiagnosticSummaries: async () => [row('m3', own('m3', 'running'))] },
      { getLiveGeneration: async () => null },
    );
    expect((await reader.listResponseStats(query)).summaries[0]).toMatchObject({
      state: 'interrupted',
      partial: true,
    });
  });

  it('looks ownership up at most once for many stale running rows', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => `m${index}`);
    const getLiveGeneration = jest.fn(async () => null);
    const reader = createLocalResponseStatsReader(
      {
        listTurnDiagnosticSummaries: async () => [
          ...ids.map((id) => row(id, own(id, 'running'))),
          row('done', own('done')),
        ],
      },
      { getLiveGeneration },
    );
    const { summaries } = await reader.listResponseStats(query);
    expect(summaries).toHaveLength(101);
    expect(summaries.filter((s) => s.state === 'interrupted')).toHaveLength(100);
    expect(getLiveGeneration).toHaveBeenCalledTimes(1);
    expect(getLiveGeneration).toHaveBeenCalledWith({ userId: 'u', conversationId: 'c' });
  });

  it('does no ownership lookup when no row is running', async () => {
    const getLiveGeneration = jest.fn(async () => null);
    const reader = createLocalResponseStatsReader(
      { listTurnDiagnosticSummaries: async () => [row('m1', own('m1')), row('m2', own('m2'))] },
      { getLiveGeneration },
    );
    expect((await reader.listResponseStats(query)).summaries).toHaveLength(2);
    expect(getLiveGeneration).not.toHaveBeenCalled();
  });

  it('treats a live job with no recorded response as owning every running row, else only its own', async () => {
    const rows = [row('m1', own('m1', 'running')), row('m2', own('m2', 'running'))];
    const store = { listTurnDiagnosticSummaries: async () => rows };
    const unknownOwner = createLocalResponseStatsReader(store, {
      getLiveGeneration: async () => ({}),
    });
    expect((await unknownOwner.listResponseStats(query)).summaries).toEqual([]);
    const oneOwner = createLocalResponseStatsReader(store, {
      getLiveGeneration: async () => ({ responseMessageId: 'm2' }),
    });
    expect(
      (await oneOwner.listResponseStats(query)).summaries.map((s) => [s.messageId, s.state]),
    ).toEqual([['m1', 'interrupted']]);
  });

  it('leaves running rows out when ownership cannot be asked', async () => {
    const reader = createLocalResponseStatsReader({
      listTurnDiagnosticSummaries: async () => [
        row('m1', own('m1', 'running')),
        row('m2', own('m2')),
      ],
    });
    expect((await reader.listResponseStats(query)).summaries.map((s) => s.messageId)).toEqual([
      'm2',
    ]);
  });

  it('returns an empty page for no snapshots but fails when the store or job lookup fails', async () => {
    const empty = createLocalResponseStatsReader({ listTurnDiagnosticSummaries: async () => [] });
    expect(await empty.listResponseStats(query)).toEqual({ summaries: [] });
    const broken = createLocalResponseStatsReader({
      listTurnDiagnosticSummaries: async () => {
        throw new Error('mongo down');
      },
    });
    await expect(broken.listResponseStats(query)).rejects.toBeInstanceOf(TraceReadError);
    const lookup = createLocalResponseStatsReader(
      { listTurnDiagnosticSummaries: async () => [row('m3', own('m3', 'running'))] },
      {
        getLiveGeneration: async () => {
          throw new Error('redis down');
        },
      },
    );
    await expect(lookup.listResponseStats(query)).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });
});
