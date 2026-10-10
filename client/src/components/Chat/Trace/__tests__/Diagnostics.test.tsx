import React from 'react';
import { Provider, createStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TTracePage, TTraceRecord, TTraceTurnSummary } from 'librechat-data-provider';
import { decodeSpeed, totalsOf } from '../diagnostics';
import { traceViewerFocusAtom } from '../store';
import TurnPanel from '../TurnPanel';
import Viewer from '../Viewer';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

jest.mock('~/data-provider/Endpoints/queries', () => ({
  useGetStartupConfig: () => ({
    data: { interface: { traceViewer: { enabled: true, source: 'local' } } },
  }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, string | number>) =>
    options ? `${key} ${Object.values(options).join(' ')}` : key,
}));

const BASE = Date.UTC(2026, 8, 12, 11, 30, 0);
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

const model = (overrides: Partial<TTraceRecord> & Pick<TTraceRecord, 'id'>): TTraceRecord => ({
  traceId: 'turn-1',
  messageId: 'response-1',
  parentId: null,
  kind: 'generation',
  name: 'model',
  model: 'qwen-test',
  source: 'local',
  outcome: 'completed',
  startTime: at(0),
  endTime: at(2700),
  status: 'ok',
  usage: { input: 120, cacheRead: 80, output: 20 },
  routing: { backend: 'gpu-a', queueMs: 250 },
  timings: {
    elapsedMs: 2700,
    firstGenerationMs: 700,
    firstGenerationKind: 'text',
    promptMs: 400,
    decodeMs: 2000,
    decodeTokens: 20,
  },
  ...overrides,
});

const turn = (overrides: Partial<TTraceTurnSummary> = {}): TTraceTurnSummary => ({
  messageId: 'response-1',
  state: 'completed',
  startTime: at(0),
  endTime: at(2700),
  elapsedMs: 2700,
  segments: 1,
  complete: true,
  notes: [],
  ...overrides,
});

const wrap = (ui: React.ReactElement, store = createStore()) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  return render(
    <Provider store={store}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </Provider>,
  );
};

describe('turn diagnostics helpers', () => {
  it('derives decode speed only from reported decode time and tokens', () => {
    expect(decodeSpeed({ decodeMs: 2000, decodeTokens: 20 })).toBe(10);
    expect(decodeSpeed({ decodeMs: 2000 })).toBeUndefined();
    expect(decodeSpeed({ decodeMs: 0, decodeTokens: 5 })).toBeUndefined();
    expect(decodeSpeed(undefined)).toBeUndefined();
  });

  it('leaves a total undefined when no record reported it, and flags a partial sum', () => {
    const none = totalsOf([model({ id: 'a', usage: undefined })]);
    expect(none.input).toBeUndefined();
    expect(none.partial).toBe(true);
    const some = totalsOf([model({ id: 'a' }), model({ id: 'b', usage: undefined })]);
    expect(some).toMatchObject({ input: 120, cacheRead: 80, output: 20, partial: true });
  });

  it.each(['failed', 'cancelled', 'incomplete'] as const)(
    'flags missing usage on a %s attempt even when another attempt succeeded',
    (outcome) => {
      const totals = totalsOf([model({ id: 'a', outcome, usage: undefined }), model({ id: 'b' })]);
      expect(totals).toMatchObject({ input: 120, output: 20, partial: true });
    },
  );
});

describe('totals with auxiliary calls', () => {
  it('keeps title and summary calls out of the answer figures and counts them apart', () => {
    const totals = totalsOf([
      model({ id: 'a' }),
      model({ id: 's', origin: 'summarization', usage: { input: 900, output: 90 } }),
      model({ id: 't', origin: 'title', usage: { input: 50, output: 5 } }),
    ]);
    expect(totals).toMatchObject({ modelCalls: 1, auxiliaryCalls: 2, input: 120, output: 20 });
  });

  it('flags a completed call that reported only one side of its usage', () => {
    expect(totalsOf([model({ id: 'a', usage: { input: 9 } })]).partial).toBe(true);
    expect(totalsOf([model({ id: 'a', usage: { output: 9 } })]).partial).toBe(true);
    expect(totalsOf([model({ id: 'a' })]).partial).toBe(false);
  });

  it('shows the auxiliary count and the new capture notes in the panel', () => {
    wrap(
      <TurnPanel
        turn={turn({ complete: false, notes: ['subagents_not_captured', 'response_unreadable'] })}
        records={[model({ id: 'a' }), model({ id: 't', origin: 'title' })]}
      />,
    );
    const panel = screen.getByTestId('trace-turn-panel');
    expect(panel).toHaveTextContent('com_ui_trace_turn_auxiliary_calls');
    expect(panel).toHaveTextContent('com_ui_trace_note_subagents_not_captured');
    expect(panel).toHaveTextContent('com_ui_trace_note_response_unreadable');
  });
});

describe('TurnPanel', () => {
  it('shows totals and never a zero for a missing metric', () => {
    wrap(
      <TurnPanel
        turn={turn({ state: 'failed', complete: false, notes: ['usage_missing'] })}
        records={[model({ id: 'a', usage: undefined, outcome: 'failed', status: 'error' })]}
      />,
    );
    const panel = screen.getByTestId('trace-turn-panel');
    expect(within(panel).getByTestId('trace-turn-state')).toHaveTextContent(
      'com_ui_trace_outcome_failed',
    );
    expect(within(panel).getAllByText('com_ui_trace_unavailable')).toHaveLength(3);
    expect(within(panel).getByText('com_ui_trace_note_usage_missing')).toBeInTheDocument();
    expect(panel).not.toHaveTextContent('NaN');
  });

  it('flags a paused, truncated and multi-segment turn', () => {
    wrap(
      <TurnPanel
        turn={turn({ state: 'paused', segments: 2, complete: false, notes: ['records_truncated'] })}
        records={[model({ id: 'a' })]}
      />,
    );
    const panel = screen.getByTestId('trace-turn-panel');
    expect(panel).toHaveTextContent('com_ui_trace_outcome_paused');
    expect(panel).toHaveTextContent('com_ui_trace_turn_segments');
    expect(panel).toHaveTextContent('com_ui_trace_note_records_truncated');
    expect(panel).not.toHaveTextContent('com_ui_trace_turn_incomplete');
  });
});

describe('Viewer with local diagnostics', () => {
  const records = [
    model({ id: 'a' }),
    model({ id: 'other', messageId: 'response-2', traceId: 'turn-2' }),
  ];

  beforeEach(() => {
    window.localStorage.clear();
    jest.spyOn(dataService, 'getConversationTraceRecords').mockResolvedValue({
      records,
      turns: [turn(), turn({ messageId: 'response-2' })],
      sourceId: 'local',
    } satisfies TTracePage);
    jest.spyOn(dataService, 'getMessagesByConvoId').mockResolvedValue([]);
    jest.spyOn(dataService, 'getConversationTraceRecord').mockResolvedValue({
      record: records[0],
      contentAvailable: false,
    });
  });

  it('shows the exact acceptance figures for the opened record', async () => {
    wrap(<Viewer conversationId="convo-1" onClose={jest.fn()} />);
    await screen.findByTestId('trace-turn-panel', undefined, { timeout: 3000 }).catch(() => null);
    const rows = await screen.findAllByRole('treeitem', { name: /^com_ui_trace_bar_description/ });
    await userEvent.click(rows[0]);
    const inspector = await screen.findByTestId('trace-inspector');
    expect(inspector).toHaveTextContent('120');
    expect(inspector).toHaveTextContent('80');
    expect(inspector).toHaveTextContent('com_ui_trace_tokens_per_second 10.0');
    expect(inspector).toHaveTextContent('gpu-a');
    expect(inspector).toHaveTextContent('com_ui_trace_queue_wait');
    expect(inspector).toHaveTextContent('com_ui_trace_first_generation_text');
  });

  it('asks the server for the focused response so an old turn needs no earlier pages', async () => {
    const store = createStore();
    store.set(traceViewerFocusAtom, 'response-2');
    const spy = dataService.getConversationTraceRecords as jest.Mock;
    wrap(<Viewer conversationId="convo-1" onClose={jest.fn()} />, store);
    await screen.findByTestId('trace-turn-panel');
    expect(spy.mock.calls.some(([params]) => params.messageId === 'response-2')).toBe(true);
  });

  it('shows how many tool results a model call with several parents used', async () => {
    (dataService.getConversationTraceRecords as jest.Mock).mockResolvedValue({
      records: [model({ id: 'a', dependsOn: ['t1', 't2'] })],
      turns: [turn()],
      sourceId: 'local',
    });
    wrap(<Viewer conversationId="convo-1" onClose={jest.fn()} />);
    const rows = await screen.findAllByRole('treeitem', { name: /^com_ui_trace_bar_description/ });
    await userEvent.click(rows[0]);
    const inspector = await screen.findByTestId('trace-inspector');
    expect(inspector).toHaveTextContent('com_ui_trace_depends_on');
  });

  it('narrows to the focused response and returns to the whole conversation on request', async () => {
    const store = createStore();
    store.set(traceViewerFocusAtom, 'response-1');
    wrap(<Viewer conversationId="convo-1" onClose={jest.fn()} />, store);
    expect(await screen.findByTestId('trace-turn-panel')).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem', { name: /^com_ui_trace_bar_description/ })).toHaveLength(
      1,
    );

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_trace_show_conversation' }));

    expect(store.get(traceViewerFocusAtom)).toBeNull();
    expect(
      await screen.findAllByRole('treeitem', { name: /^com_ui_trace_bar_description/ }),
    ).toHaveLength(2);
    expect(screen.queryByTestId('trace-turn-panel')).not.toBeInTheDocument();
  });
});
