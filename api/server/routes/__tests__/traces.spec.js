const express = require('express');
const request = require('supertest');
const { createHash } = require('crypto');

const mockGetConvoOwnership = jest.fn();
const mockGetConversationTraceRefs = jest.fn();
const mockHasSampledTraceMessage = jest.fn();
const mockListTurnDiagnostics = jest.fn();
const mockListTurnDiagnosticMessageIds = jest.fn();
const mockListTurnDiagnosticSummaries = jest.fn();
let mockUser;
let mockTraceViewer;

jest.mock('~/models', () => ({
  getConvoOwnership: (...args) => mockGetConvoOwnership(...args),
  getConversationTraceRefs: (...args) => mockGetConversationTraceRefs(...args),
  hasSampledTraceMessage: (...args) => mockHasSampledTraceMessage(...args),
  listTurnDiagnostics: (...args) => mockListTurnDiagnostics(...args),
  listTurnDiagnosticMessageIds: (...args) => mockListTurnDiagnosticMessageIds(...args),
  listTurnDiagnosticSummaries: (...args) => mockListTurnDiagnosticSummaries(...args),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    if (!mockUser) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    req.user = mockUser;
    next();
  },
}));

jest.mock('~/server/middleware/config/app', () => (req, _res, next) => {
  req.config = { interfaceConfig: { traceViewer: mockTraceViewer } };
  next();
});

const traceIdFor = (seed) => createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32);

const langfuseEnv = {
  LANGFUSE_PUBLIC_KEY: 'pk-route',
  LANGFUSE_SECRET_KEY: 'sk-route',
  LANGFUSE_PROJECT_ID: 'route-project',
  LANGFUSE_BASE_URL: 'https://langfuse.route.test',
};

describe('trace routes', () => {
  let app;
  let fetchSpy;

  beforeAll(() => {
    Object.assign(process.env, langfuseEnv);
    const tracesRouter = require('../traces');
    app = express();
    app.use('/api/traces', tracesRouter);
  });

  afterAll(() => {
    for (const key of Object.keys(langfuseEnv)) {
      delete process.env[key];
    }
  });

  beforeEach(() => {
    mockUser = { id: 'owner', role: 'USER' };
    mockTraceViewer = { enabled: true };
    mockGetConvoOwnership.mockResolvedValue({ user: 'owner' });
    mockGetConversationTraceRefs.mockResolvedValue({
      firstMessageAt: new Date('2026-09-12T11:00:00.000Z'),
      sampledMessages: [{ messageId: 'response-1' }],
    });
    mockHasSampledTraceMessage.mockResolvedValue(true);
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'obs-root',
                traceId: traceIdFor('response-1'),
                startTime: '2026-09-12T11:30:00.000Z',
                endTime: '2026-09-12T11:30:02.000Z',
                parentObservationId: null,
                type: 'AGENT',
                name: 'AgentGraph',
                level: 'DEFAULT',
              },
              {
                id: 'obs-foreign',
                traceId: traceIdFor('other-response'),
                startTime: '2026-09-12T11:31:00.000Z',
                endTime: '2026-09-12T11:31:02.000Z',
                parentObservationId: null,
                type: 'AGENT',
                name: 'AgentGraph',
              },
            ],
            meta: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('requires authentication', async () => {
    mockUser = undefined;

    const response = await request(app).get('/api/traces/convo-1/records');

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads the owner's sampled traces from Langfuse without exposing other traces", async () => {
    const availability = await request(app).get('/api/traces/convo-1/availability');
    const response = await request(app).get('/api/traces/convo-1/records');

    expect(availability.body).toEqual({ available: true });
    expect(response.status).toBe(200);
    expect(response.body.records.map(({ id }) => id)).toEqual(['obs-root']);
    expect(response.body.records[0]).toMatchObject({ messageId: 'response-1', kind: 'agent' });
    expect(mockGetConvoOwnership).toHaveBeenCalledWith('owner', 'convo-1', null);
    expect(mockHasSampledTraceMessage).toHaveBeenCalledWith({
      user: 'owner',
      conversationId: 'convo-1',
      tenantId: undefined,
      destinationIds: [
        createHash('sha256').update('https://langfuse.route.test\nroute-project').digest('hex'),
      ],
    });
    expect(mockGetConversationTraceRefs).toHaveBeenCalledWith({
      user: 'owner',
      conversationId: 'convo-1',
      tenantId: undefined,
      limit: 51,
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(new URL(url).origin).toBe('https://langfuse.route.test');
    expect(JSON.parse(new URL(url).searchParams.get('filter'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'sessionId', operator: '=', value: 'convo-1' }),
        expect.objectContaining({ column: 'traceId', operator: 'any of' }),
        expect.objectContaining({ column: 'userId', operator: 'any of', value: ['owner'] }),
      ]),
    );
    expect(new Headers(init.headers).get('Authorization')).toBe(
      `Basic ${Buffer.from('pk-route:sk-route').toString('base64')}`,
    );
    expect(JSON.stringify(response.body)).not.toContain('sk-route');
  });

  it("refuses another user's conversation before reading Langfuse", async () => {
    mockGetConvoOwnership.mockResolvedValue(null);

    const availability = await request(app).get('/api/traces/convo-1/availability');
    const response = await request(app).get(
      '/api/traces/convo-1/records/obs-root?message=response-1',
    );

    expect(availability.body).toEqual({ available: false });
    expect(response.status).toBe(404);
    expect(mockGetConversationTraceRefs).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays off until the deployment enables the viewer', async () => {
    mockTraceViewer = undefined;

    const response = await request(app).get('/api/traces/convo-1/records');

    expect(response.status).toBe(404);
    expect(response.body.errorCode).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('local source', () => {
    const diagnostics = {
      version: 1,
      turn: {
        messageId: 'response-1',
        state: 'completed',
        startTime: '2026-09-12T11:30:00.000Z',
        segments: 1,
        complete: true,
        notes: [],
      },
      records: [
        {
          id: 'response-1:s1.m1',
          traceId: 'response-1',
          messageId: 'response-1',
          parentId: null,
          kind: 'generation',
          role: 'model',
          name: 'model',
          startTime: '2026-09-12T11:30:00.000Z',
          status: 'ok',
          source: 'local',
          usage: { input: 120, output: 20, cacheRead: 80 },
        },
      ],
    };

    beforeEach(() => {
      mockTraceViewer = { enabled: true, source: 'local' };
      mockListTurnDiagnostics.mockResolvedValue([
        { messageId: 'response-1', orderKey: `1.${'a'.repeat(24)}`, diagnostics },
      ]);
      mockListTurnDiagnosticMessageIds.mockResolvedValue(['response-1']);
      mockListTurnDiagnosticSummaries.mockResolvedValue([{ messageId: 'response-1', diagnostics }]);
    });

    it('serves stored diagnostics for the owner without touching Langfuse', async () => {
      const availability = await request(app).get('/api/traces/convo-1/availability');
      const records = await request(app).get('/api/traces/convo-1/records');
      const detail = await request(app).get(
        '/api/traces/convo-1/records/response-1:s1.m1?message=response-1',
      );

      expect(availability.body).toEqual({ available: true, messageIds: ['response-1'] });
      expect(records.status).toBe(200);
      expect(records.body.records[0]).toMatchObject({ id: 'response-1:s1.m1', source: 'local' });
      expect(records.body.turns[0]).toMatchObject({ messageId: 'response-1', complete: true });
      expect(detail.status).toBe(200);
      expect(detail.body.contentAvailable).toBe(false);
      expect(mockListTurnDiagnostics).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'owner', conversationId: 'convo-1' }),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockGetConversationTraceRefs).not.toHaveBeenCalled();
    });

    it('refuses another user’s conversation before reading diagnostics', async () => {
      mockGetConvoOwnership.mockResolvedValue({ user: 'someone-else' });

      const response = await request(app).get('/api/traces/convo-1/records');

      expect(response.status).toBeGreaterThanOrEqual(403);
      expect(mockListTurnDiagnostics).not.toHaveBeenCalled();
    });

    it('reads one response by focus and rejects a cursor it did not issue', async () => {
      const focused = await request(app).get('/api/traces/convo-1/records?message=response-1');
      expect(focused.status).toBe(200);
      expect(mockListTurnDiagnostics).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'response-1', limit: 1 }),
      );
      mockListTurnDiagnostics.mockClear();

      const bad = await request(app).get('/api/traces/convo-1/records?cursor=not-a-cursor');
      expect(bad.status).toBe(400);
      expect(bad.body.records).toBeUndefined();
      expect(mockListTurnDiagnostics).not.toHaveBeenCalled();
    });

    it('shows a stored running turn as interrupted unless a live job owns it', async () => {
      const { GenerationJobManager } = require('@librechat/api');
      const running = { ...diagnostics, turn: { ...diagnostics.turn, state: 'running' } };
      mockListTurnDiagnostics.mockResolvedValue([
        { messageId: 'response-1', orderKey: `1.${'a'.repeat(24)}`, diagnostics: running },
      ]);
      const getJob = jest.fn().mockResolvedValue(undefined);
      const spy = jest.spyOn(GenerationJobManager, 'getJobStore').mockReturnValue({ getJob });
      try {
        const stale = await request(app).get('/api/traces/convo-1/records');
        expect(stale.body.turns[0]).toMatchObject({ state: 'interrupted', complete: false });
        expect(getJob).toHaveBeenCalledWith('convo-1');

        getJob.mockResolvedValue({ status: 'running', responseMessageId: 'response-1' });
        const live = await request(app).get('/api/traces/convo-1/records');
        expect(live.body.turns[0].state).toBe('running');
      } finally {
        spy.mockRestore();
      }
    });

    describe('response summaries', () => {
      const get = (id = 'convo-1') => request(app).get(`/api/traces/${id}/summaries`);

      it('serves one compact summary per answer from one read, not the snapshot', async () => {
        const response = await get();

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.body.summaries).toEqual([
          expect.objectContaining({
            messageId: 'response-1',
            state: 'completed',
            modelCalls: 1,
            toolCalls: 0,
            input: 120,
            cacheRead: 80,
            output: 20,
            partial: false,
          }),
        ]);
        expect(response.body.records).toBeUndefined();
        expect(mockListTurnDiagnosticSummaries).toHaveBeenCalledTimes(1);
        expect(mockListTurnDiagnosticSummaries).toHaveBeenCalledWith({
          user: 'owner',
          conversationId: 'convo-1',
          tenantId: undefined,
        });
        expect(mockListTurnDiagnostics).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it('names tools only when the deployment shows them', async () => {
        const withTool = {
          ...diagnostics,
          records: [
            ...diagnostics.records,
            {
              ...diagnostics.records[0],
              id: 'response-1:s1.t1',
              kind: 'tool',
              name: 'search_code',
              usage: undefined,
            },
          ],
        };
        mockListTurnDiagnosticSummaries.mockResolvedValue([
          { messageId: 'response-1', diagnostics: withTool },
        ]);
        expect(JSON.stringify((await get()).body)).not.toContain('search_code');
        mockTraceViewer = { enabled: true, source: 'local', showToolNames: true };
        expect((await get()).body.summaries[0].tools).toEqual([{ name: 'search_code' }]);
      });

      it.each([
        ['another user', { user: 'someone-else' }],
        ['another tenant', { user: 'owner', tenantId: 'tenant-b' }],
        ['a missing conversation', null],
        ['a subagent thread', { user: 'owner', subagentThread: { parentConversationId: 'p' } }],
      ])('refuses %s before reading any summaries', async (_label, conversation) => {
        mockGetConvoOwnership.mockResolvedValue(conversation);

        const response = await get('convo-2');

        expect(response.status).toBe(404);
        expect(response.body.errorCode).toBe('not_found');
        expect(mockGetConvoOwnership).toHaveBeenCalledWith('owner', 'convo-2', null);
        expect(mockListTurnDiagnosticSummaries).not.toHaveBeenCalled();
      });

      it('scopes the read to the requester’s tenant', async () => {
        mockUser = { id: 'owner', role: 'USER', tenantId: 'tenant-a' };
        mockGetConvoOwnership.mockResolvedValue({ user: 'owner', tenantId: 'tenant-b' });
        expect((await get()).status).toBe(404);
        mockGetConvoOwnership.mockResolvedValue({ user: 'owner', tenantId: 'tenant-a' });
        expect((await get()).status).toBe(200);
        expect(mockListTurnDiagnosticSummaries).toHaveBeenCalledWith(
          expect.objectContaining({ tenantId: 'tenant-a' }),
        );
      });

      it('settles many stale running answers with one job lookup, none when nothing runs', async () => {
        const running = (id) => ({
          messageId: id,
          diagnostics: {
            version: 1,
            turn: { messageId: id, state: 'running' },
            records: [],
          },
        });
        const rows = Array.from({ length: 50 }, (_, i) => running(`stale-${i}`));
        const { GenerationJobManager } = require('@librechat/api');
        const getJob = jest.fn().mockResolvedValue(undefined);
        const spy = jest.spyOn(GenerationJobManager, 'getJobStore').mockReturnValue({ getJob });
        try {
          mockListTurnDiagnosticSummaries.mockResolvedValue(rows);
          const stale = await get();
          expect(stale.body.summaries).toHaveLength(50);
          expect(stale.body.summaries.every((s) => s.state === 'interrupted')).toBe(true);
          expect(getJob).toHaveBeenCalledTimes(1);
          expect(getJob).toHaveBeenCalledWith('convo-1');

          getJob.mockClear();
          getJob.mockResolvedValue({ status: 'running', responseMessageId: 'stale-3' });
          const live = await get();
          expect(live.body.summaries).toHaveLength(49);
          expect(live.body.summaries.map((s) => s.messageId)).not.toContain('stale-3');
          expect(getJob).toHaveBeenCalledTimes(1);

          getJob.mockClear();
          mockListTurnDiagnosticSummaries.mockResolvedValue([
            { messageId: 'response-1', diagnostics },
          ]);
          await get();
          expect(getJob).not.toHaveBeenCalled();

          mockListTurnDiagnosticSummaries.mockResolvedValue(rows);
          getJob.mockRejectedValue(new Error('redis://secret-host'));
          const failed = await get();
          expect(failed.status).toBeGreaterThanOrEqual(500);
          expect(JSON.stringify(failed.body)).not.toContain('secret-host');
        } finally {
          spy.mockRestore();
        }
      });

      it('requires authentication and the local source', async () => {
        mockUser = undefined;
        expect((await get()).status).toBe(401);
        mockUser = { id: 'owner', role: 'USER' };
        mockTraceViewer = { enabled: true };
        expect((await get()).body.errorCode).toBe('unsupported');
        mockTraceViewer = { enabled: false };
        expect((await get()).body.errorCode).toBe('disabled');
        expect(mockListTurnDiagnosticSummaries).not.toHaveBeenCalled();
      });

      it('answers an empty page for no snapshots but a failure for a failed read', async () => {
        mockListTurnDiagnosticSummaries.mockResolvedValue([]);
        const empty = await get();
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual({ summaries: [] });

        mockListTurnDiagnosticSummaries.mockRejectedValue(new Error('mongodb://secret-host'));
        const failed = await get();
        expect(failed.status).toBeGreaterThanOrEqual(500);
        expect(failed.body.summaries).toBeUndefined();
        expect(JSON.stringify(failed.body)).not.toContain('secret-host');
      });
    });

    it('does not echo a failed read', async () => {
      mockListTurnDiagnostics.mockRejectedValue(new Error('mongodb://secret-host'));

      const response = await request(app).get('/api/traces/convo-1/records');

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(response.body)).not.toContain('secret-host');
    });
  });
});
