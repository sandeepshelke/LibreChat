import React from 'react';
import { Provider, createStore } from 'jotai';
import { dataService } from 'librechat-data-provider';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { traceViewerConversationAtom, traceViewerFocusAtom } from '../store';
import useResponseTrace from '../useResponseTrace';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

let mockConfig: unknown = {};
jest.mock('~/data-provider/Endpoints/queries', () => ({
  useGetStartupConfig: () => ({ data: mockConfig }),
}));

function setup(enabled = true, messageId = 'response-1') {
  const store = createStore();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </Provider>
  );
  const hook = renderHook(
    () => useResponseTrace({ conversationId: 'convo-1', messageId, enabled }),
    { wrapper },
  );
  return { store, ...hook };
}

describe('useResponseTrace', () => {
  beforeEach(() => {
    mockConfig = { interface: { traceViewer: { enabled: true, source: 'local' } } };
    jest
      .spyOn(dataService, 'getConversationTraceAvailability')
      .mockResolvedValue({ available: true, messageIds: ['response-1'] });
  });

  it('is offered for a response with diagnostics and opens the trace focused on it', async () => {
    const { result, store } = setup();
    await waitFor(() => expect(result.current.show).toBe(true));
    act(() => result.current.open());
    expect(store.get(traceViewerConversationAtom)).toBe('convo-1');
    expect(store.get(traceViewerFocusAtom)).toBe('response-1');
  });

  it('is not offered for a response without diagnostics', async () => {
    const { result } = setup(true, 'response-2');
    await waitFor(() => expect(dataService.getConversationTraceAvailability).toHaveBeenCalled());
    expect(result.current.show).toBe(false);
  });

  it('does nothing in Langfuse mode or when disabled', async () => {
    mockConfig = { interface: { traceViewer: { enabled: true } } };
    const langfuse = setup();
    const off = setup(false);
    expect(langfuse.result.current.show).toBe(false);
    expect(off.result.current.show).toBe(false);
    expect(dataService.getConversationTraceAvailability).not.toHaveBeenCalled();
  });
});
