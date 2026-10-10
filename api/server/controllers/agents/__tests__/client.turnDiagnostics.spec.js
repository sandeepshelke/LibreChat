const { createTurnDiagnostics } = require('@librechat/api');
const AgentClient = require('../client');

const bare = (overrides = {}) => ({
  turnDiagnostics: createTurnDiagnostics({ messageId: 'm1', maxRecords: 10 }),
  abortController: undefined,
  ...overrides,
});
const fields = (context, input) =>
  AgentClient.prototype.getTurnDiagnosticsFields.call(context, input);

describe('AgentClient.getTurnDiagnosticsFields', () => {
  it('is empty when diagnostics are off', () => {
    expect(fields(bare({ turnDiagnostics: null }))).toEqual({});
  });

  it('defaults to completed only when nothing went wrong', () => {
    expect(fields(bare()).turnDiagnostics.turn.state).toBe('completed');
  });

  it('propagates a caught terminal error and the step limit instead of claiming completed', () => {
    expect(fields(bare({ terminalRunFailed: true })).turnDiagnostics.turn.state).toBe('failed');
    expect(fields(bare({ stepLimitReached: true })).turnDiagnostics.turn.state).toBe('incomplete');
  });

  it('reports cancellation and a pending approval', () => {
    const abortController = new AbortController();
    abortController.abort();
    expect(fields(bare({ abortController })).turnDiagnostics.turn.state).toBe('cancelled');
    expect(fields(bare({ pendingApproval: { id: 'a' } })).turnDiagnostics.turn.state).toBe(
      'paused',
    );
  });

  it('lets an explicit failed state win for the error row', () => {
    expect(
      fields(bare(), { state: 'failed', messageId: 'err' }).turnDiagnostics.turn,
    ).toMatchObject({
      state: 'failed',
      messageId: 'err',
    });
  });
});
