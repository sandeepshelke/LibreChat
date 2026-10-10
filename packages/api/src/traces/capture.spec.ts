import http from 'http';
import type { TTurnDiagnostics } from 'librechat-data-provider';
import type { AddressInfo } from 'net';
import { createTurnDiagnostics } from './capture';
import { createLocalTraceReader } from './local';
import type { LocalTraceStore } from './local';
import { createResponseMeter } from './meter';
import { resolveTurnState, restoreTurnDiagnostics, persistSettledDiagnostics } from './controller';
import { TraceReadError } from './types';

const SECRET = 'SECRET-PROMPT-TEXT-12345';

const sse = (frames: unknown[]): string =>
  frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('');

const finalStream = sse([
  { choices: [{ delta: { content: `héllo ${SECRET}` } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  {
    choices: [],
    usage: { prompt_tokens: 120, completion_tokens: 20 },
    timings: { cache_n: 80, prompt_n: 40, prompt_ms: 100, predicted_n: 20, predicted_ms: 2000 },
  },
  '[DONE]',
]);

const toolStream = sse([
  {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{}' } }],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } },
  '[DONE]',
]);

type Behavior = {
  body: string;
  status?: number;
  headers?: Record<string, string>;
  splitAt?: number;
  stall?: boolean;
};

async function withServer<T>(
  behaviors: Behavior[],
  fn: (url: string, closed: () => number) => Promise<T>,
): Promise<T> {
  let index = 0;
  let closedCount = 0;
  const server = http.createServer((req, res) => {
    const behavior = behaviors[Math.min(index++, behaviors.length - 1)];
    res.writeHead(behavior.status ?? 200, {
      'content-type': 'text/event-stream',
      ...behavior.headers,
    });
    req.on('close', () => {
      closedCount++;
    });
    if (behavior.stall === true) {
      res.write(behavior.body);
      return;
    }
    const bytes = Buffer.from(behavior.body, 'utf8');
    const at = behavior.splitAt ?? bytes.length;
    res.write(bytes.subarray(0, at));
    setTimeout(() => res.end(bytes.subarray(at)), 5);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      () => closedCount,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const make = () => createTurnDiagnostics({ messageId: 'msg-1', maxRecords: 50 });

describe('turn diagnostics capture', () => {
  it('records a model → tool → model turn with normalized usage, routing and parenting', async () => {
    await withServer(
      [
        {
          body: toolStream,
          headers: { 'x-llm-router-queue-ms': '250', 'x-llm-router-backend': 'gpu-1' },
        },
        {
          body: finalStream,
          headers: { 'x-llm-router-queue-ms': '5', 'x-llm-router-backend': 'gpu-1' },
        },
      ],
      async (url) => {
        const diagnostics = make();
        const call = diagnostics.wrapFetch(undefined, { model: 'qwen' });
        const first = await call(url as never, { method: 'POST', body: SECRET } as never);
        await first.text();
        diagnostics.tools.prepared({ id: 'step_1', toolCallId: 'call_1', observed_at: Date.now() });
        diagnostics.tools.dispatched({
          dispatched_at: Date.now(),
          toolCalls: [{ id: 'call_1', name: 'lookup', stepId: 'step_1' }],
        });
        diagnostics.tools.completed({
          result: {
            id: 'step_1',
            completed_at: Date.now() + 30,
            tool_call: { id: 'call_1', name: 'lookup' },
          },
        });
        const second = await call(
          url as never,
          {
            method: 'POST',
            body: JSON.stringify({
              messages: [
                { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
                { role: 'tool', tool_call_id: 'call_1', content: 'x' },
              ],
            }),
          } as never,
        );
        expect(await second.text()).toBe(finalStream);

        const snapshot = diagnostics.snapshot('completed');
        expect(snapshot.turn).toMatchObject({ state: 'completed', complete: true, segments: 1 });
        const [m1, m2] = snapshot.records.filter((r) => r.kind === 'generation');
        const tool = snapshot.records.find((r) => r.kind === 'tool');
        expect(m1.routing).toEqual({ backend: 'gpu-1', queueMs: 250 });
        expect(m1.usage).toMatchObject({ input: 50, output: 5 });
        expect(m2.usage).toMatchObject({ input: 120, output: 20, cacheRead: 80 });
        expect(m2.timings).toMatchObject({
          decodeMs: 2000,
          decodeTokens: 20,
          firstGenerationKind: 'text',
        });
        expect(m2.parentId).toBe(tool?.id);
        expect(tool?.parentId).toBe(m1.id);
        expect(tool?.outcome).toBe('completed');
        expect(JSON.stringify(snapshot)).not.toContain(SECRET);
      },
    );
  });

  it('passes bytes through unchanged when split mid-UTF-8 and mid-frame', async () => {
    const bytes = Buffer.from(finalStream, 'utf8');
    const at = bytes.indexOf(Buffer.from('é', 'utf8')) + 1;
    await withServer([{ body: finalStream, splitAt: at }], async (url) => {
      const diagnostics = make();
      const res = await diagnostics.wrapFetch(undefined)(url as never, {} as never);
      const received = Buffer.from(await res.arrayBuffer());
      expect(received.equals(bytes)).toBe(true);
      expect(diagnostics.snapshot('completed').records[0].usage?.input).toBe(120);
    });
  });

  it('marks a stream cut before [DONE] incomplete and keeps missing usage unavailable', async () => {
    const cut = sse([{ choices: [{ delta: { content: 'x' } }] }]);
    await withServer([{ body: cut }], async (url) => {
      const diagnostics = make();
      const res = await diagnostics.wrapFetch(undefined)(url as never, {} as never);
      await res.text();
      const snapshot = diagnostics.snapshot('completed');
      expect(snapshot.records[0]).toMatchObject({
        outcome: 'incomplete',
        errorCode: 'stream_truncated',
      });
      expect(snapshot.records[0].usage).toBeUndefined();
    });
  });

  it('records HTTP failures by class without the response body', async () => {
    await withServer(
      [
        {
          body: `{"error":"${SECRET}"}`,
          status: 429,
          headers: { 'content-type': 'application/json' },
        },
      ],
      async (url) => {
        const diagnostics = make();
        const res = await diagnostics.wrapFetch(undefined)(url as never, {} as never);
        expect(res.status).toBe(429);
        expect(await res.text()).toContain(SECRET);
        const snapshot = diagnostics.snapshot('failed');
        expect(snapshot.records[0]).toMatchObject({
          outcome: 'failed',
          errorCode: 'rate_limited',
          httpStatus: 429,
          status: 'error',
        });
        expect(JSON.stringify(snapshot)).not.toContain(SECRET);
      },
    );
  });

  it('records cancellation and propagates the cancel upstream', async () => {
    await withServer(
      [{ body: sse([{ choices: [{ delta: { content: 'x' } }] }]), stall: true }],
      async (url, closed) => {
        const diagnostics = make();
        const res = await diagnostics.wrapFetch(undefined)(url as never, {} as never);
        const reader = res.body!.getReader();
        await reader.read();
        await reader.cancel();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(closed()).toBe(1);
        expect(diagnostics.snapshot('cancelled').records[0]).toMatchObject({
          outcome: 'cancelled',
          status: 'warning',
        });
      },
    );
  });

  it('rejects hostile router headers and keeps the values unavailable', async () => {
    await withServer(
      [
        {
          body: finalStream,
          headers: { 'x-llm-router-queue-ms': '-4', 'x-llm-router-backend': 'a b<script>' },
        },
      ],
      async (url) => {
        const diagnostics = make();
        await (await diagnostics.wrapFetch(undefined)(url as never, {} as never)).text();
        const snapshot = diagnostics.snapshot('completed');
        expect(snapshot.records[0].routing).toBeUndefined();
        expect(snapshot.turn.notes).toContain('router_header_invalid');
      },
    );
  });

  it('keeps a paused tool open across a resume and updates it in place', () => {
    const first = make();
    first.tools.dispatched({
      dispatched_at: 1_700_000_000_000,
      toolCalls: [{ id: 'c1', name: 'ask', stepId: 's1' }],
    });
    const paused = first.snapshot('paused');
    expect(paused.turn.state).toBe('paused');
    expect(paused.records[0]).toMatchObject({ kind: 'tool', outcome: 'paused', status: 'warning' });

    const second = make();
    second.seed(JSON.parse(JSON.stringify(paused)) as TTurnDiagnostics);
    second.tools.completed({
      result: { id: 's1', completed_at: 1_700_000_005_000, tool_call: { id: 'c1' } },
    });
    const done = second.snapshot('completed');
    expect(done.turn.segments).toBe(2);
    expect(done.records).toHaveLength(1);
    expect(done.records[0]).toMatchObject({ id: paused.records[0].id, outcome: 'completed' });
  });

  it('caps records and says so', async () => {
    const diagnostics = createTurnDiagnostics({ messageId: 'msg-1', maxRecords: 1 });
    diagnostics.tools.dispatched({ toolCalls: [{ id: 'a' }, { id: 'b' }] });
    const snapshot = diagnostics.snapshot('completed');
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.turn).toMatchObject({ droppedRecords: 1, complete: false });
    expect(snapshot.turn.notes).toContain('records_truncated');
  });

  it('classifies tool errors without storing messages', () => {
    const diagnostics = make();
    diagnostics.tools.dispatched({ toolCalls: [{ id: 'a', name: 'x' }] });
    diagnostics.tools.failed({ id: 'a', error: new Error(SECRET) });
    const snapshot = diagnostics.snapshot('failed');
    expect(snapshot.records[0]).toMatchObject({ outcome: 'failed', errorCode: 'tool_exception' });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });

  it('notes provider paths it cannot meter', () => {
    const diagnostics = make();
    diagnostics.noteModelsNotCaptured();
    const snapshot = diagnostics.snapshot('completed');
    expect(snapshot.turn.complete).toBe(false);
    expect(snapshot.turn.notes).toContain('models_not_captured');
  });
});

describe('response meter', () => {
  it('handles CRLF frames split across chunks and a bare CR', () => {
    const meter = createResponseMeter({ contentType: 'text/event-stream', now: () => 0 });
    const text =
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = Buffer.from(text);
    for (let i = 0; i < bytes.length; i += 3) {
      meter.push(bytes.subarray(i, i + 3));
    }
    const result = meter.finish();
    expect(result.usage).toMatchObject({ promptTokens: 7, completionTokens: 3 });
    expect(result.terminated).toBe(true);
  });

  it('reads a non-streaming JSON usage', () => {
    const meter = createResponseMeter({ contentType: 'application/json', now: () => 0 });
    meter.push(
      Buffer.from(
        '{"choices":[{"message":{"content":"x"}}],"usage":{"prompt_tokens":9,"completion_tokens":2}}',
      ),
    );
    expect(meter.finish().usage).toMatchObject({ promptTokens: 9, completionTokens: 2 });
  });
});

describe('local trace reader', () => {
  const row = (messageId: string, diagnostics: TTurnDiagnostics) => ({
    messageId,
    orderKey: `1.${'a'.repeat(24)}`,
    diagnostics,
  });
  const settings = {
    enabled: true,
    source: 'local' as const,
    showInputOutput: false,
    showToolNames: false,
    maxRecords: 100,
    maxContentLength: 1000,
    requestsPerMinute: 30,
    requestTimeoutMs: 1000,
    maxLocalRecordsPerTurn: 100,
  };

  it('drops forged records, redacts tool names, and scopes every read', async () => {
    const d = make();
    d.tools.dispatched({ toolCalls: [{ id: 'a', name: 'private_tool' }] });
    const own = d.snapshot('completed');
    const forged: TTurnDiagnostics = {
      ...own,
      records: [
        ...own.records,
        { ...own.records[0], id: 'x', messageId: 'other', traceId: 'other' },
      ],
    };
    const calls: unknown[] = [];
    const reader = createLocalTraceReader({
      listTurnDiagnostics: async (input) => {
        calls.push(input);
        return [row('msg-1', forged)];
      },
      listTurnDiagnosticMessageIds: async () => ['msg-1'],
    });
    const query = { userId: 'u1', tenantId: 't1', conversationId: 'c1', settings };
    const page = await reader.listRecords(query);
    expect(page.records).toHaveLength(1);
    expect(page.records[0].name).toBe('tool');
    expect(page.turns).toHaveLength(1);
    expect(calls[0]).toMatchObject({ user: 'u1', tenantId: 't1', conversationId: 'c1' });
    expect(await reader.getRecord({ ...query, recordId: 'x', messageId: 'msg-1' })).toBeNull();
    const detail = await reader.getRecord({
      ...query,
      recordId: own.records[0].id,
      messageId: 'msg-1',
    });
    expect(detail?.contentAvailable).toBe(false);
    expect(await reader.isAvailable(query)).toEqual({ available: true, messageIds: ['msg-1'] });
  });

  it('reports store failures as upstream errors', async () => {
    const reader = createLocalTraceReader({
      listTurnDiagnostics: async () => {
        throw new Error('mongo down');
      },
      listTurnDiagnosticMessageIds: async () => {
        throw new Error('mongo down');
      },
    });
    await expect(
      reader.listRecords({ userId: 'u', conversationId: 'c', settings }),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });
});

const twoToolStream = sse([
  {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_a', function: { name: 'one', arguments: '{}' } },
            { index: 1, id: 'call_b', function: { name: 'two', arguments: '{}' } },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  '[DONE]',
]);

const toolResults = (...ids: string[]) =>
  JSON.stringify({
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', tool_calls: ids.map((id) => ({ id })) },
      ...ids.map((id) => ({ role: 'tool', tool_call_id: id, content: 'r' })),
    ],
  });

describe('ancestry is proven, never guessed', () => {
  it('keeps concurrent model calls as roots instead of chaining them by time', async () => {
    await withServer([{ body: finalStream }], async (url) => {
      const diagnostics = make();
      const call = diagnostics.wrapFetch(undefined, { model: 'qwen' });
      await Promise.all(
        [1, 2, 3].map(async () => (await call(url, { method: 'POST', body: '{}' })).text()),
      );
      const models = diagnostics
        .snapshot('completed')
        .records.filter((r) => r.kind === 'generation');
      expect(models).toHaveLength(3);
      expect(models.map((m) => m.parentId)).toEqual([null, null, null]);
      expect(models.every((m) => m.dependsOn == null)).toBe(true);
    });
  });

  it('links parallel tools to their model and a later model to all of them via dependsOn', async () => {
    await withServer([{ body: twoToolStream }, { body: finalStream }], async (url) => {
      const diagnostics = make();
      const call = diagnostics.wrapFetch(undefined, { model: 'qwen' });
      await (await call(url, { method: 'POST', body: '{}' })).text();
      diagnostics.tools.dispatched({
        toolCalls: [
          { id: 'call_a', name: 'one', stepId: 'sa' },
          { id: 'call_b', name: 'two', stepId: 'sb' },
        ],
      });
      // The later one completes first: completion order must not matter.
      diagnostics.tools.completed({ result: { id: 'sb', tool_call: { id: 'call_b' } } });
      diagnostics.tools.completed({ result: { id: 'sa', tool_call: { id: 'call_a' } } });
      await (await call(url, { method: 'POST', body: toolResults('call_a', 'call_b') })).text();
      const { records } = diagnostics.snapshot('completed');
      const [m1, m2] = records.filter((r) => r.kind === 'generation');
      const toolsOut = records.filter((r) => r.kind === 'tool');
      expect(toolsOut.map((t) => t.parentId)).toEqual([m1.id, m1.id]);
      expect(m2.parentId).toBeNull();
      expect([...(m2.dependsOn ?? [])].sort()).toEqual(toolsOut.map((t) => t.id).sort());
    });
  });

  it('gives a tool no parent when no model stream carried its id', () => {
    const diagnostics = make();
    diagnostics.tools.dispatched({ toolCalls: [{ id: 'orphan', name: 'x' }] });
    expect(diagnostics.snapshot('completed').records[0].parentId).toBeNull();
  });
});

describe('tool elapsed comes only from the monotonic clock', () => {
  const clock = () => {
    const t = { mono: 1000, wall: 1_700_000_000_000 };
    const d = createTurnDiagnostics({
      messageId: 'msg-1',
      maxRecords: 50,
      now: () => t.mono,
      wall: () => t.wall,
    });
    return { t, d };
  };

  it('uses the monotonic delta and ignores a wall-clock jump', () => {
    const { t, d } = clock();
    d.tools.dispatched({ toolCalls: [{ id: 'c', name: 'x', stepId: 's' }] });
    t.mono += 250;
    t.wall -= 3_600_000;
    d.tools.completed({ result: { id: 's', completed_at: t.wall, tool_call: { id: 'c' } } });
    const tool = d.snapshot('completed').records[0];
    expect(tool.timings?.elapsedMs).toBe(250);
  });

  it('does not cap or invent a duration longer than the wall clock claims', () => {
    const { t, d } = clock();
    d.tools.dispatched({ toolCalls: [{ id: 'c', stepId: 's' }] });
    t.mono += 60_000;
    d.tools.completed({ result: { id: 's', tool_call: { id: 'c' } } });
    expect(d.snapshot('completed').records[0].timings?.elapsedMs).toBe(60_000);
  });

  it('reports no elapsed for a tool completed without a dispatch in this segment', () => {
    const { d } = clock();
    d.tools.completed({ result: { id: 's', tool_call: { id: 'c' } } });
    const tool = d.snapshot('completed').records[0];
    expect(tool.timings?.elapsedMs).toBeUndefined();
    expect(tool.endTime).toBeUndefined();
  });

  it('after a resume, measures only a re-dispatch inside the new segment', () => {
    const { t, d } = clock();
    d.tools.dispatched({ toolCalls: [{ id: 'c', name: 'ask', stepId: 's' }] });
    const paused = JSON.parse(JSON.stringify(d.snapshot('paused'))) as TTurnDiagnostics;

    const resumed = clock();
    resumed.d.seed(paused);
    resumed.t.mono += 90_000;
    resumed.d.tools.completed({ result: { id: 's', tool_call: { id: 'c' } } });
    expect(resumed.d.snapshot('completed').records[0].timings?.elapsedMs).toBeUndefined();

    const again = clock();
    again.d.seed(paused);
    again.d.tools.dispatched({ toolCalls: [{ id: 'c', name: 'ask', stepId: 's' }] });
    again.t.mono += 40;
    again.d.tools.completed({ result: { id: 's', tool_call: { id: 'c' } } });
    expect(again.d.snapshot('completed').records[0].timings?.elapsedMs).toBe(40);
    expect(t.mono).toBe(1000);
  });
});

describe('response meter bounds', () => {
  const run = (type: string, chunks: Array<string | Buffer>) => {
    const meter = createResponseMeter({ contentType: type, now: () => 0 });
    for (const chunk of chunks) {
      meter.push(Buffer.from(chunk));
    }
    return meter.finish();
  };

  it('bounds one huge line however the chunks fall and counts it unreadable', () => {
    const huge = 'x'.repeat(3_000_000);
    const result = run('text/event-stream', [
      'data: {"a":"',
      huge.slice(0, 1_000_000),
      huge.slice(1_000_000),
      '"}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
    ]);
    expect(result.unreadable).toBeGreaterThan(0);
    expect(result.usage).toMatchObject({ promptTokens: 4, completionTokens: 1 });
    expect(result.terminated).toBe(true);
  });

  it('bounds an event made of very many data lines', () => {
    const lines = 'data: {"k":1}\n'.repeat(5000);
    const result = run('text/event-stream', [
      lines,
      '\n',
      'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\n',
    ]);
    expect(result.unreadable).toBeGreaterThan(0);
    expect(result.usage).toMatchObject({ promptTokens: 2, completionTokens: 2 });
  });

  it('flushes a final frame that has no blank line before finish', () => {
    const result = run('text/event-stream', [
      'data: {"choices":[],"usage":{"prompt_tokens":6,"completion_tokens":1}}\n\n',
      'data: [DONE]',
    ]);
    expect(result.usage).toMatchObject({ promptTokens: 6, completionTokens: 1 });
    expect(result.terminated).toBe(true);
    const last = run('text/event-stream', [
      'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2}}',
    ]);
    expect(last.usage).toMatchObject({ promptTokens: 8, completionTokens: 2 });
  });

  it('does not call a truncated or malformed JSON body terminated', () => {
    expect(run('application/json', ['{"usage":{"prompt_tokens":1']).terminated).not.toBe(true);
    const bad = run('application/json', ['not json at all']);
    expect(bad.terminated).not.toBe(true);
  });

  it('keeps partial usage visible as partial', async () => {
    await withServer(
      [{ body: sse([{ choices: [], usage: { prompt_tokens: 9 } }, '[DONE]']) }],
      async (url) => {
        const diagnostics = make();
        await (
          await diagnostics.wrapFetch(undefined, { model: 'm' })(url, { method: 'POST' })
        ).text();
        const snapshot = diagnostics.snapshot('completed');
        expect(snapshot.records[0].usage?.input).toBe(9);
        expect(snapshot.records[0].usage?.output).toBeUndefined();
        expect(snapshot.turn.notes).toContain('usage_missing');
      },
    );
  });

  it('passes bytes through untouched when the meter gives up', async () => {
    const big = sse([{ choices: [{ delta: { content: 'y'.repeat(2_000_000) } }] }, '[DONE]']);
    await withServer([{ body: big }], async (url) => {
      const diagnostics = make();
      const response = await diagnostics.wrapFetch(undefined, { model: 'm' })(url, {
        method: 'POST',
      });
      expect(await response.text()).toBe(big);
    });
  });

  it('marks a non-stream response that never completed as incomplete', async () => {
    await withServer(
      [{ body: '{"usage":{"prompt_tokens":1', headers: { 'content-type': 'application/json' } }],
      async (url) => {
        const diagnostics = make();
        await (
          await diagnostics.wrapFetch(undefined, { model: 'm' })(url, { method: 'POST' })
        ).text();
        const snapshot = diagnostics.snapshot('completed');
        expect(snapshot.records[0]).toMatchObject({ outcome: 'incomplete' });
        expect(snapshot.turn.complete).toBe(false);
      },
    );
  });
});

describe('terminal outcomes and resume', () => {
  it('lets a caught terminal error or step limit override completed', () => {
    expect(resolveTurnState({})).toBe('completed');
    expect(resolveTurnState({ terminalError: true })).toBe('failed');
    expect(resolveTurnState({ stepLimitReached: true })).toBe('incomplete');
    expect(resolveTurnState({ terminalError: true, aborted: true })).toBe('cancelled');
    expect(resolveTurnState({ pendingApproval: true, terminalError: true })).toBe('paused');
    expect(resolveTurnState({ state: 'failed', aborted: true })).toBe('failed');
  });

  it('marks the turn capture_failed when the stored snapshot cannot be restored', async () => {
    const warn = jest.fn();
    const a = make();
    await restoreTurnDiagnostics(
      a,
      async () => {
        throw new Error('db down');
      },
      { warn },
    );
    const b = make();
    await restoreTurnDiagnostics(b, async () => undefined);
    for (const d of [a, b]) {
      const snapshot = d.snapshot('completed');
      expect(snapshot.turn.notes).toContain('capture_failed');
      expect(snapshot.turn.complete).toBe(false);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('re-saves only a snapshot that had already settled', async () => {
    const save = jest.fn(async () => undefined);
    const fresh = make();
    await persistSettledDiagnostics(fresh, save);
    expect(save).not.toHaveBeenCalled();
    fresh.snapshot('failed', 'msg-1');
    await persistSettledDiagnostics(fresh, save);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-1',
        turnDiagnostics: expect.objectContaining({
          turn: expect.objectContaining({ state: 'failed' }),
        }),
      }),
    );
  });

  it('records summarization and title calls under their origin and flags subagents', async () => {
    await withServer([{ body: finalStream }], async (url) => {
      const diagnostics = make();
      await (
        await diagnostics.wrapFetch(undefined, { model: 'm' })(url, { method: 'POST' })
      ).text();
      await (
        await diagnostics.wrapFetch(undefined, { model: 'm', origin: 'summarization' })(url, {
          method: 'POST',
        })
      ).text();
      await (
        await diagnostics.wrapFetch(undefined, { model: 'm', origin: 'title' })(url, {
          method: 'POST',
        })
      ).text();
      diagnostics.note('subagents_not_captured');
      const snapshot = diagnostics.snapshot('completed');
      expect(snapshot.records.map((r) => r.origin)).toEqual([undefined, 'summarization', 'title']);
      expect(snapshot.turn.notes).toContain('subagents_not_captured');
      expect(snapshot.turn.complete).toBe(false);
    });
  });

  it('fires an armed note only when its trigger happens', () => {
    const d = make();
    d.armNote('summarization', 'models_not_captured');
    expect(d.snapshot('completed').turn.notes).not.toContain('models_not_captured');
    d.fireNote('summarization');
    expect(d.snapshot('completed').turn.notes).toContain('models_not_captured');
  });
});

describe('local reader limits, focus and staleness', () => {
  type ListInput = Parameters<LocalTraceStore['listTurnDiagnostics']>[0];
  const key = (n: number) => `${n.toString(36)}.${'a'.repeat(24)}`;
  const settings = {
    enabled: true,
    source: 'local' as const,
    showInputOutput: false,
    showToolNames: true,
    maxRecords: 3,
    maxContentLength: 1000,
    requestsPerMinute: 30,
    requestTimeoutMs: 1000,
    maxLocalRecordsPerTurn: 100,
  };
  const turn = (messageId: string, tools: number, state: 'completed' | 'running' = 'completed') => {
    const d = createTurnDiagnostics({ messageId, maxRecords: 50 });
    d.tools.dispatched({
      toolCalls: Array.from({ length: tools }, (_, i) => ({ id: `${messageId}-${i}`, name: 't' })),
    });
    return d.snapshot(state, messageId);
  };
  const store = (rows: Record<string, { n: number; diagnostics: TTurnDiagnostics }>) => {
    const sorted = Object.entries(rows).sort((a, b) => b[1].n - a[1].n);
    return {
      listTurnDiagnostics: jest.fn(async (input: ListInput) => {
        let list = sorted.map(([messageId, r]) => ({
          messageId,
          orderKey: key(r.n),
          diagnostics: r.diagnostics,
        }));
        if (input.messageId != null) {
          list = list.filter((r) => r.messageId === input.messageId);
        }
        const { through } = input;
        if (through != null) {
          list = list.filter((r) =>
            through.inclusive === true
              ? r.orderKey <= through.orderKey
              : r.orderKey < through.orderKey,
          );
        }
        return list.slice(0, input.limit);
      }),
      listTurnDiagnosticMessageIds: jest.fn(async () => sorted.map(([id]) => id)),
    };
  };
  const query = { userId: 'u', conversationId: 'c', settings };

  it('honors maxRecords inside a first oversized turn and continues within it', async () => {
    const reader = createLocalTraceReader(store({ big: { n: 5, diagnostics: turn('big', 8) } }));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await reader.listRecords({ ...query, cursor });
      expect(page.records.length).toBeLessThanOrEqual(3);
      seen.push(...page.records.map((r) => r.id));
      cursor = page.nextCursor;
      if (cursor == null) {
        break;
      }
    }
    expect(new Set(seen).size).toBe(8);
  });

  it('reads one old response by focus without loading the history before it', async () => {
    const rows: Record<string, { n: number; diagnostics: TTurnDiagnostics }> = {};
    for (let i = 0; i < 50; i++) {
      rows[`m${i}`] = { n: i + 1, diagnostics: turn(`m${i}`, 1) };
    }
    const s = store(rows);
    const reader = createLocalTraceReader(s);
    const page = await reader.listRecords({ ...query, messageId: 'm0' });
    expect(page.records.map((r) => r.messageId)).toEqual(['m0']);
    expect(page.nextCursor).toBeUndefined();
    expect(s.listTurnDiagnostics.mock.calls[0][0]).toMatchObject({ messageId: 'm0', limit: 1 });
    const availability = await reader.isAvailable(query);
    expect(availability.messageIds).toHaveLength(50);
  });

  it('rejects an invalid cursor instead of returning an empty page', async () => {
    const reader = createLocalTraceReader(store({ a: { n: 1, diagnostics: turn('a', 1) } }));
    for (const cursor of [
      '%%%',
      Buffer.from('a:nope').toString('base64url'),
      Buffer.from(`w:${key(9)}:x`).toString('base64url'),
      Buffer.from(`w:${key(9)}:1`).toString('base64url'),
    ]) {
      await expect(reader.listRecords({ ...query, cursor })).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    expect(TraceReadError).toBeDefined();
  });

  it('shows an unowned running snapshot as interrupted and leaves live ones alone', async () => {
    const rows = { r: { n: 1, diagnostics: turn('r', 1, 'running') } };
    const stale = createLocalTraceReader(store(rows), { isGenerationLive: async () => false });
    const page = await stale.listRecords(query);
    expect(page.turns?.[0]).toMatchObject({ state: 'interrupted', complete: false });
    expect(page.turns?.[0].notes).toContain('process_ended');
    expect(page.records[0]).toMatchObject({ outcome: 'interrupted' });

    const live = createLocalTraceReader(store(rows), { isGenerationLive: async () => true });
    expect((await live.listRecords(query)).turns?.[0].state).toBe('running');

    const broken = createLocalTraceReader(store(rows), {
      isGenerationLive: async () => {
        throw new Error('redis');
      },
    });
    await expect(broken.listRecords(query)).rejects.toMatchObject({ code: 'upstream_error' });
    await expect(
      broken.getRecord({ ...query, messageId: 'r', recordId: page.records[0].id }),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });
});
