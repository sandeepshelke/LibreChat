import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IMessage } from '..';
import { createMessageMethods } from './message';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let Message: mongoose.Model<IMessage>;
let methods: ReturnType<typeof createMessageMethods>;

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 1, 12, minutes));
const snapshot = (messageId: string) => ({
  version: 1 as const,
  turn: {
    messageId,
    state: 'completed' as const,
    startTime: at(0).toISOString(),
    segments: 1,
    complete: true,
    notes: [],
  },
  records: [],
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  Message = mongoose.models.Message as mongoose.Model<IMessage>;
  methods = createMessageMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Message.deleteMany({});
});

describe('turn diagnostics storage', () => {
  it('lists only the owner’s server-authored responses in this tenant and conversation, newest first', async () => {
    await Message.collection.insertMany([
      {
        messageId: 'old',
        conversationId: 'c',
        user: 'u',
        createdAt: at(1),
        isCreatedByUser: false,
        turnDiagnostics: snapshot('old'),
      },
      {
        messageId: 'new',
        conversationId: 'c',
        user: 'u',
        createdAt: at(2),
        isCreatedByUser: false,
        turnDiagnostics: snapshot('new'),
      },
      {
        messageId: 'other-user',
        conversationId: 'c',
        user: 'v',
        createdAt: at(3),
        isCreatedByUser: false,
        turnDiagnostics: snapshot('other-user'),
      },
      {
        messageId: 'other-convo',
        conversationId: 'd',
        user: 'u',
        createdAt: at(3),
        isCreatedByUser: false,
        turnDiagnostics: snapshot('other-convo'),
      },
      {
        messageId: 'other-tenant',
        conversationId: 'c',
        user: 'u',
        tenantId: 't',
        createdAt: at(3),
        isCreatedByUser: false,
        turnDiagnostics: snapshot('other-tenant'),
      },
      {
        messageId: 'forged',
        conversationId: 'c',
        user: 'u',
        createdAt: at(4),
        isCreatedByUser: false,
        isUserSubmitted: true,
        turnDiagnostics: snapshot('forged'),
      },
      {
        messageId: 'user-turn',
        conversationId: 'c',
        user: 'u',
        createdAt: at(5),
        isCreatedByUser: true,
        turnDiagnostics: snapshot('user-turn'),
      },
      {
        messageId: 'plain',
        conversationId: 'c',
        user: 'u',
        createdAt: at(6),
        isCreatedByUser: false,
      },
    ]);
    const rows = await methods.listTurnDiagnostics({ user: 'u', conversationId: 'c', limit: 10 });
    expect(rows.map((row) => row.messageId)).toEqual(['new', 'old']);
    expect(await methods.listTurnDiagnosticMessageIds({ user: 'u', conversationId: 'c' })).toEqual([
      'new',
      'old',
    ]);
    const scoped = await methods.listTurnDiagnostics({
      user: 'u',
      conversationId: 'c',
      tenantId: 't',
      limit: 10,
    });
    expect(scoped.map((row) => row.messageId)).toEqual(['other-tenant']);
  });

  it('pages by order key and narrows to one message', async () => {
    await Message.collection.insertMany(
      [1, 2, 3].map((n) => ({
        messageId: `m${n}`,
        conversationId: 'c',
        user: 'u',
        createdAt: at(n),
        isCreatedByUser: false,
        turnDiagnostics: snapshot(`m${n}`),
      })),
    );
    const [first] = await methods.listTurnDiagnostics({ user: 'u', conversationId: 'c', limit: 1 });
    expect(first.messageId).toBe('m3');
    const rest = await methods.listTurnDiagnostics({
      user: 'u',
      conversationId: 'c',
      through: { orderKey: first.orderKey },
      limit: 10,
    });
    expect(rest.map((row) => row.messageId)).toEqual(['m2', 'm1']);
    const inclusive = await methods.listTurnDiagnostics({
      user: 'u',
      conversationId: 'c',
      through: { orderKey: first.orderKey, inclusive: true },
      limit: 10,
    });
    expect(inclusive.map((row) => row.messageId)).toEqual(['m3', 'm2', 'm1']);
    await expect(
      methods.listTurnDiagnostics({
        user: 'u',
        conversationId: 'c',
        through: { orderKey: 'bad' },
        limit: 5,
      }),
    ).rejects.toThrow('Invalid turn diagnostics cursor');
    const one = await methods.listTurnDiagnostics({
      user: 'u',
      conversationId: 'c',
      messageId: 'm2',
      limit: 5,
    });
    expect(one.map((row) => row.messageId)).toEqual(['m2']);
  });

  it('projects summaries for every owned response, oldest first, without unneeded snapshot fields', async () => {
    const rich = (messageId: string) => ({
      ...snapshot(messageId),
      turn: {
        ...snapshot(messageId).turn,
        elapsedMs: 1200,
        notes: ['usage_missing'],
        droppedRecords: 2,
      },
      records: [
        {
          id: 'r1',
          traceId: messageId,
          messageId,
          parentId: null,
          kind: 'generation',
          name: 'model',
          startTime: at(0).toISOString(),
          status: 'ok',
          errorCode: 'secret_code',
          toolCallId: 'call_x',
          usage: { input: 10, output: 5, cacheRead: 4, total: 15 },
          routing: { backend: 'gpu-1', queueMs: 30 },
          timings: { elapsedMs: 900, promptMs: 100, decodeMs: 500, decodeTokens: 5 },
        },
      ],
    });
    await Message.collection.insertMany([
      ...[3, 1, 2].map((n) => ({
        messageId: `m${n}`,
        conversationId: 'c',
        user: 'u',
        createdAt: at(n),
        isCreatedByUser: false,
        turnDiagnostics: rich(`m${n}`),
      })),
      {
        messageId: 'other-user',
        conversationId: 'c',
        user: 'v',
        createdAt: at(4),
        isCreatedByUser: false,
        turnDiagnostics: rich('other-user'),
      },
      {
        messageId: 'other-tenant',
        conversationId: 'c',
        user: 'u',
        tenantId: 't',
        createdAt: at(4),
        isCreatedByUser: false,
        turnDiagnostics: rich('other-tenant'),
      },
      {
        messageId: 'other-convo',
        conversationId: 'd',
        user: 'u',
        createdAt: at(4),
        isCreatedByUser: false,
        turnDiagnostics: rich('other-convo'),
      },
      {
        messageId: 'forged',
        conversationId: 'c',
        user: 'u',
        createdAt: at(4),
        isCreatedByUser: false,
        isUserSubmitted: true,
        turnDiagnostics: rich('forged'),
      },
      {
        messageId: 'plain',
        conversationId: 'c',
        user: 'u',
        createdAt: at(5),
        isCreatedByUser: false,
      },
    ]);
    const rows = await methods.listTurnDiagnosticSummaries({ user: 'u', conversationId: 'c' });
    expect(rows.map((row) => row.messageId)).toEqual(['m1', 'm2', 'm3']);
    const [record] = rows[0].diagnostics.records;
    expect(record).toMatchObject({
      kind: 'generation',
      usage: { input: 10, output: 5, cacheRead: 4 },
      routing: { queueMs: 30 },
      timings: { promptMs: 100, decodeMs: 500, decodeTokens: 5 },
    });
    expect(record.usage).not.toHaveProperty('total');
    expect(record).not.toHaveProperty('errorCode');
    expect(record).not.toHaveProperty('toolCallId');
    expect(record.routing).not.toHaveProperty('backend');
    expect(record).not.toHaveProperty('status');
    expect(rows[0].diagnostics.turn).toEqual({
      messageId: 'm1',
      state: 'completed',
      elapsedMs: 1200,
      complete: true,
      notes: ['usage_missing'],
      droppedRecords: 2,
    });
    const tenant = await methods.listTurnDiagnosticSummaries({
      user: 'u',
      conversationId: 'c',
      tenantId: 't',
    });
    expect(tenant.map((row) => row.messageId)).toEqual(['other-tenant']);
    expect(
      await methods.listTurnDiagnosticSummaries({ user: 'u', conversationId: 'missing' }),
    ).toEqual([]);
  });

  it('never returns diagnostics through the ordinary message reads', async () => {
    await Message.create({
      messageId: 'm',
      conversationId: 'c',
      user: 'u',
      isCreatedByUser: false,
      turnDiagnostics: snapshot('m'),
    });
    const messages = await methods.getMessages({ user: 'u', conversationId: 'c' });
    expect(JSON.stringify(messages)).not.toContain('turnDiagnostics');
    const rows = await methods.listTurnDiagnostics({ user: 'u', conversationId: 'c', limit: 5 });
    expect(rows).toHaveLength(1);
  });
});
