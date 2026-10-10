import React from 'react';
import { Provider, createStore } from 'jotai';
import { dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContext } from '@librechat/client';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import type { TResponseStats } from 'librechat-data-provider';
import { traceViewerConversationAtom, traceViewerFocusAtom } from '../store';
import ResponseStatsLine, { ResponseStatsProvider } from '../ResponseStats';
import { statsLine, statsRows, rowsToHtml } from '../stats';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import translations from '~/locales/en/translation.json';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

const mockLocalize = (key: string, options?: Record<string, string | number>) => {
  const template = (translations as Record<string, string>)[key] ?? key;
  return template.replace(/{{(\w+)}}/g, (_m, name) => String(options?.[name] ?? ''));
};
jest.mock('../stats', () => {
  const actual = jest.requireActual<typeof import('../stats')>('../stats');
  return { ...actual, statsRows: jest.fn(actual.statsRows) };
});

jest.mock('~/hooks', () => ({ useLocalize: () => mockLocalize }));

let mockConfig: unknown = {};
jest.mock('~/data-provider/Endpoints/queries', () => ({
  useGetStartupConfig: () => ({ data: mockConfig }),
}));

const call = {
  elapsedMs: 10000,
  queueMs: 0,
  firstGenerationMs: 800,
  firstGenerationKind: 'tool_call' as const,
  input: 20100,
  cacheRead: 19900,
  newTokens: 200,
  output: 200,
  prefillTps: 250,
  decodeTps: 21.3,
};

const example: TResponseStats = {
  messageId: 'response-1',
  state: 'completed',
  elapsedMs: 34100,
  modelCalls: 2,
  toolCalls: 2,
  input: 41200,
  cacheRead: 38000,
  output: 812,
  prefillTps: 410.3,
  decodeTps: 21.3,
  partial: false,
  calls: [
    call,
    {
      ...call,
      elapsedMs: 22000,
      firstGenerationKind: 'reasoning',
      input: 21100,
      cacheRead: 18100,
      newTokens: 3000,
      output: 612,
      prefillTps: 428.6,
      decodeTps: undefined,
    },
  ],
  tools: [{ name: 'search <docs>', elapsedMs: 1200 }, { elapsedMs: 300 }],
};

const t = mockLocalize as never;

describe('response stats formatting', () => {
  it('renders the exact line from reported figures', () => {
    expect(statsLine(example, t, 'en-US')).toBe(
      '34.1 s · 2 calls · 2 tools · 41.2K in (38.0K cached) · 812 out · prefill 410 t/s · decode 21.3 t/s',
    );
  });

  it('shows only reported positive fields and says when it is partial', () => {
    const sparse: TResponseStats = {
      messageId: 'r',
      state: 'completed',
      modelCalls: 1,
      toolCalls: 0,
      input: 0,
      cacheRead: 0,
      output: 812,
      prefillTps: Number.NaN,
      partial: true,
      calls: [],
      tools: [],
    };
    const line = statsLine(sparse, t, 'en-US');
    expect(line).toBe('1 call · 812 out · partial');
    expect(line).not.toMatch(/NaN|undefined|\b0\b/);
  });

  it('formats speeds by magnitude and says paused', () => {
    const paused = { ...example, state: 'paused' as const, prefillTps: 99.96, decodeTps: 99.4 };
    const line = statsLine(paused, t, 'en-US');
    expect(line.startsWith('paused · ')).toBe(true);
    expect(line).toContain('prefill 100 t/s');
    expect(line).toContain('decode 99.4 t/s');
  });

  it('lists model calls chronologically, then tools, without a TTFT label', () => {
    const rows = statsRows(example, t, 'en-US');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('call 1');
    expect(rows[0]).toContain('first tool call 0.8 s');
    expect(rows[1]).toContain('first reasoning 0.8 s');
    expect(rows[2]).toBe('tool search <docs> · 1.2 s');
    expect(rows[3]).toBe('tool · 0.3 s');
    expect(rows.join(' ')).not.toMatch(/ttft/i);
  });

  it('omits positive figures that would print as 0.0 and keeps the first that shows', () => {
    const short: TResponseStats = {
      ...example,
      elapsedMs: 40,
      prefillTps: 0.04,
      decodeTps: 0.05,
      calls: [{ elapsedMs: 49, queueMs: 40, firstGenerationMs: 30, prefillTps: 0.04, output: 3 }],
      tools: [{ name: 'web_search', elapsedMs: 20 }],
    };
    expect(statsLine(short, t, 'en-US')).not.toMatch(/0\.0|34\.1/);
    expect(statsLine(short, t, 'en-US')).toContain('decode 0.1 t/s');
    expect(statsLine(short, t, 'en-US')).not.toContain('prefill');
    expect(statsRows(short, t, 'en-US')).toEqual(['call 1 · 3 out', 'tool Web Search']);
    const edge = { ...short, calls: [{ queueMs: 50 }] };
    expect(statsRows(edge, t, 'en-US')[0]).toBe('call 1 · queue 0.1 s');
  });

  it('names tools as the viewer does and honors tool names being hidden', () => {
    const named: TResponseStats = {
      ...example,
      calls: [],
      tools: [
        { name: 'lookup_weather_mcp_fixture', elapsedMs: 1200 },
        { name: 'web_search' },
        { name: 'plain_tool' },
        { elapsedMs: 300 },
      ],
    };
    expect(statsRows(named, t, 'en-US')).toEqual([
      'tool lookup_weather (fixture) · 1.2 s',
      'tool Web Search',
      'tool plain_tool',
      'tool · 0.3 s',
    ]);
  });

  it('escapes tool names before the tooltip renders them as HTML', () => {
    const html = rowsToHtml(statsRows(example, t, 'en-US'));
    expect(html).toContain('search &lt;docs&gt;');
    expect(html).not.toContain('<docs>');
    expect(html).toContain('<br>');
  });
});

type Props = {
  conversationId?: string;
  ids: string[];
  submitting?: boolean;
  expected?: string | null;
};

function Harness({ conversationId = 'convo-1', ids, submitting = false, expected }: Props) {
  return (
    <ResponseStatsProvider
      conversationId={conversationId}
      isSubmitting={submitting}
      expectedMessageId={expected}
    >
      {ids.map((id) => (
        <div key={id} className="group">
          <ResponseStatsLine
            conversationId={conversationId}
            messageId={id}
            alwaysVisible={id === ids[ids.length - 1]}
          />
        </div>
      ))}
    </ResponseStatsProvider>
  );
}

const showToast = jest.fn();

function setup(props: Props) {
  const store = createStore();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (next: Props) => (
    <Provider store={store}>
      <ToastContext.Provider value={{ showToast }}>
        <QueryClientProvider client={client}>
          <Harness {...next} />
        </QueryClientProvider>
      </ToastContext.Provider>
    </Provider>
  );
  const view = render(wrap(props));
  return { store, client, rerenderWith: (next: Props) => view.rerender(wrap(next)) };
}

const pauseAction = { actionId: 'a', payload: { type: 'tool_approval' } } as never;

describe('ResponseStatsLine', () => {
  let spy: jest.SpyInstance;
  const ids = ['response-1', 'response-2', 'response-3'];
  const rows = (...messageIds: string[]) => ({
    summaries: messageIds.map((messageId) => ({ ...example, messageId })),
  });
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        if ((setTimeout as { clock?: unknown }).clock) {
          await jest.advanceTimersByTimeAsync(0);
        }
      }
    });

  beforeEach(() => {
    showToast.mockClear();
    (statsRows as jest.Mock).mockClear();
    mockConfig = { interface: { traceViewer: { enabled: true, source: 'local' } } };
    spy = jest.spyOn(dataService, 'getConversationResponseStats').mockResolvedValue({
      summaries: [
        { ...example, messageId: 'response-1' },
        { ...example, messageId: 'response-2', state: 'paused' },
      ],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('fetches once for many rows and renders only rows with a summary', async () => {
    setup({ ids });
    await screen.findAllByRole('button');
    expect(screen.getAllByRole('button')).toHaveLength(2);
    const buttons = screen.getAllByRole('button', { name: /Response statistics/ });
    expect(buttons[0].textContent).toBe('');
    expect(buttons[0].querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    act(() => buttons[1].focus());
    expect(await screen.findByText(/paused · 34\.1 s/)).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('formats no tooltip until a row is hovered or focused, and never refetches for it', async () => {
    setup({ ids, submitting: true });
    const buttons = await screen.findAllByRole('button');
    expect(statsRows).not.toHaveBeenCalled();
    fireEvent.mouseEnter(buttons[0]);
    await waitFor(() => expect(statsRows).toHaveBeenCalledTimes(1));
    fireEvent.focus(buttons[1]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('shows the tooltip on real keyboard focus and opens the viewer on Enter', async () => {
    const { store } = setup({ ids });
    const [button] = await screen.findAllByRole('button');
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    expect(await screen.findByText(/first tool call/)).toBeTruthy();
    fireEvent.click(button);
    expect(store.get(traceViewerFocusAtom)).toBe('response-1');
    expect(store.get(traceViewerConversationAtom)).toBe('convo-1');
  });

  it('renders tool names as text, never as markup', async () => {
    const payload = `<img src=x onerror="alert(1)"> & "q" <script>x</script>`;
    spy.mockResolvedValue({
      summaries: [{ ...example, messageId: 'response-1', calls: [], tools: [{ name: payload }] }],
    });
    setup({ ids: ['response-1'] });
    const [button] = await screen.findAllByRole('button');
    act(() => button.focus());
    const text = await screen.findByText(/tool <img src=x/);
    expect(text.textContent).toContain(payload);
    expect(document.querySelector('img, script')).toBeNull();
    expect(document.body.innerHTML).not.toContain('<img');
  });

  it('refreshes once when the answer completes', async () => {
    const { rerenderWith } = setup({ ids, submitting: true });
    await screen.findAllByRole('button');
    rerenderWith({ ids, submitting: false });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('replaces an initial request still in flight when the answer completes', async () => {
    let releaseInitial: (page: ReturnType<typeof rows>) => void = () => undefined;
    spy.mockReset();
    spy.mockImplementationOnce(() => new Promise((resolve) => (releaseInitial = resolve)));
    spy.mockResolvedValue(rows('response-1', 'response-2'));
    const { rerenderWith } = setup({ ids, submitting: true });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerenderWith({ ids, submitting: false });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await screen.findAllByRole('button');
    await act(async () => releaseInitial(rows('response-1')));
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('asks again, bounded, until a save that landed late shows the newest answer', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    spy.mockReset();
    spy
      .mockResolvedValueOnce(rows('response-1'))
      .mockResolvedValueOnce(rows('response-1'))
      .mockResolvedValue(rows('response-1', 'response-2'));
    const { rerenderWith } = setup({ ids, submitting: true, expected: 'response-2' });
    await settle();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    jest.advanceTimersByTime(5);
    rerenderWith({ ids, submitting: false, expected: 'response-2' });
    await settle();
    await settle();
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await settle();
    expect(spy).toHaveBeenCalledTimes(3);
    await settle();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    await settle();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('stops asking after two retries when the newest answer never gets stats', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    spy.mockReset();
    spy.mockResolvedValue(rows('response-1'));
    const { rerenderWith } = setup({ ids, submitting: true, expected: 'response-9' });
    await settle();
    jest.advanceTimersByTime(5);
    rerenderWith({ ids, submitting: false, expected: 'response-9' });
    await settle();
    await settle();
    await settle();
    for (const wait of [1000, 3000, 60_000]) {
      await act(async () => {
        jest.advanceTimersByTime(wait);
      });
      await settle();
    }
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('retries a stale paused snapshot after the same response finishes resuming', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    spy.mockReset();
    const pausedPage = { summaries: [{ ...example, state: 'paused' as const }] };
    spy
      .mockResolvedValueOnce(pausedPage)
      .mockResolvedValueOnce(pausedPage)
      .mockResolvedValue(rows('response-1'));
    const { rerenderWith } = setup({ ids, submitting: true, expected: 'response-1' });
    await settle();
    jest.advanceTimersByTime(5);
    rerenderWith({ ids, submitting: false, expected: 'response-1' });
    await settle();
    await settle();
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await settle();
    expect(spy).toHaveBeenCalledTimes(3);
    act(() => screen.getByRole('button', { name: /Response statistics/ }).focus());
    expect(await screen.findByText(/34\.1 s · 2 calls/)).toBeTruthy();
    expect(screen.queryByText(/paused/)).toBeNull();
  });

  it('shows totals on hover even when no per-call records are available', async () => {
    spy.mockResolvedValue({ summaries: [{ ...example, calls: [], tools: [] }] });
    setup({ ids: ['response-1'] });
    const button = await screen.findByRole('button', { name: /Response statistics/ });
    expect(screen.queryByText(/41\.2K in/)).toBeNull();
    await userEvent.hover(button);
    expect(await screen.findByText(/41\.2K in \(38\.0K cached\)/)).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not retry an earlier settle once generation has resumed', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    spy.mockResolvedValue(rows('response-1'));
    const { rerenderWith } = setup({ ids, submitting: true, expected: 'response-2' });
    await settle();
    jest.advanceTimersByTime(5);
    rerenderWith({ ids, submitting: false, expected: 'response-2' });
    await settle();
    await settle();
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
    rerenderWith({ ids, submitting: true, expected: 'response-2' });
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refreshes once when a pause and the run ending arrive together', async () => {
    const { store, rerenderWith } = setup({ ids, submitting: true });
    await screen.findAllByRole('button');
    await act(async () => {
      store.set(pendingApprovalActionFamily('convo-1'), pauseAction);
      rerenderWith({ ids, submitting: false });
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refreshes for a pause that leaves the run busy', async () => {
    const { store } = setup({ ids, submitting: true });
    await screen.findAllByRole('button');
    await act(async () => store.set(pendingApprovalActionFamily('convo-1'), pauseAction));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('does not refresh the old conversation when the view switches while busy', async () => {
    const { rerenderWith } = setup({ ids, submitting: true });
    await screen.findAllByRole('button');
    rerenderWith({ ids, conversationId: 'convo-2', submitting: false });
    await settle();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    await settle();
    expect(spy.mock.calls.map(([id]) => id)).toEqual(['convo-1', 'convo-2']);
  });

  it('refreshes again for an aborted run and for its resume', async () => {
    const { rerenderWith } = setup({ ids, submitting: true });
    await screen.findAllByRole('button');
    rerenderWith({ ids, submitting: false });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    rerenderWith({ ids, submitting: true });
    await settle();
    expect(spy).toHaveBeenCalledTimes(2);
    rerenderWith({ ids, submitting: false });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
  });

  it('shows nothing and says nothing for an empty page', async () => {
    spy.mockResolvedValue({ summaries: [] });
    setup({ ids });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await settle();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('shows no line but one safe error when the read fails, never one per row', async () => {
    spy.mockRejectedValue(new Error('mongodb://secret-host'));
    setup({ ids });
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    await settle();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(showToast).toHaveBeenCalledTimes(1);
    const [{ message, status }] = showToast.mock.calls[0];
    expect(status).toBe('error');
    expect(message).toBe(translations.com_ui_response_stats_error);
    expect(message).not.toContain('secret-host');
  });

  it('hides cached figures when a completion refresh fails', async () => {
    const { rerenderWith } = setup({ ids, submitting: true });
    await screen.findAllByRole('button');
    spy.mockRejectedValue(new Error('private failure detail'));
    rerenderWith({ ids, submitting: false });
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('does no work when diagnostics are disabled or not local', async () => {
    mockConfig = { interface: { traceViewer: { enabled: false } } };
    const off = setup({ ids, submitting: true });
    off.rerenderWith({ ids, submitting: false });
    mockConfig = { interface: { traceViewer: { enabled: true } } };
    setup({ ids, submitting: true });
    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
