import { QueryKeys, dataService } from 'librechat-data-provider';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  TTracePage,
  TResponseStatsPage,
  TTraceAvailability,
  TTraceRecordParams,
  TTraceRecordDetail,
} from 'librechat-data-provider';
import type {
  QueryClient,
  InfiniteData,
  UseInfiniteQueryResult,
  QueryObserverResult,
  UseQueryOptions,
} from '@tanstack/react-query';
import { getResponseStatus } from '~/utils/errors';

const MAX_AVAILABILITY_RETRIES = 10;
const MAX_AVAILABILITY_RETRIES_ON_ERROR = 3;

/** Availability flips only when a response is sampled, so callers re-enable it after a turn. */
export const useConversationTraceAvailabilityQuery = (
  conversationId: string,
  config?: UseQueryOptions<TTraceAvailability>,
): QueryObserverResult<TTraceAvailability> =>
  useQuery<TTraceAvailability>(
    [QueryKeys.conversationTraceAvailability, conversationId],
    () => dataService.getConversationTraceAvailability(conversationId),
    {
      /** A hidden control has no error to show, so a transient failure retries on its own. */
      retry: (failureCount, error) => {
        const status = getResponseStatus(error);
        return (
          failureCount < MAX_AVAILABILITY_RETRIES_ON_ERROR && (status == null || status >= 500)
        );
      },
      refetchOnWindowFocus: false,
      /** The server asks again only while it cannot decide yet, and only a few times. */
      refetchInterval: (data, query) =>
        data?.retryAfterMs != null && query.state.dataUpdateCount < MAX_AVAILABILITY_RETRIES
          ? data.retryAfterMs
          : false,
      ...config,
    },
  );

/**
 * Every saved answer's stats for one conversation, in one request. Only the owner of the
 * subscription refreshes it, when an answer settles or pauses, so rows read it without fetching.
 */
export const useConversationResponseStatsQuery = (
  conversationId: string,
  enabled: boolean,
): QueryObserverResult<TResponseStatsPage> =>
  useQuery<TResponseStatsPage>(
    [QueryKeys.conversationResponseStats, conversationId],
    ({ signal }) => dataService.getConversationResponseStats(conversationId, signal),
    {
      enabled,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

export const useConversationTraceRecordsQuery = (
  conversationId: string,
  enabled: boolean,
  messageId?: string | null,
): UseInfiniteQueryResult<TTracePage> =>
  useInfiniteQuery<TTracePage>({
    queryKey: [QueryKeys.conversationTraceRecords, conversationId, messageId ?? null],
    queryFn: ({ pageParam, signal }) =>
      dataService.getConversationTraceRecords(
        {
          conversationId,
          cursor: typeof pageParam === 'string' ? pageParam : undefined,
          ...(messageId != null && { messageId }),
        },
        signal,
      ),
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
    enabled,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

/** `sourceId` is the page that listed the record, so the detail reads the same project. */
export const useConversationTraceRecordQuery = (
  {
    conversationId,
    recordId,
    messageId,
    sourceId,
  }: Omit<TTraceRecordParams, 'recordId'> & {
    recordId: string | null;
  },
  enabled: boolean,
): QueryObserverResult<TTraceRecordDetail> =>
  useQuery<TTraceRecordDetail>(
    [QueryKeys.conversationTraceRecord, conversationId, recordId, messageId, sourceId ?? null],
    ({ signal }) =>
      dataService.getConversationTraceRecord(
        { conversationId, recordId: recordId ?? '', messageId, sourceId },
        signal,
      ),
    {
      enabled: enabled && recordId != null,
      retry: false,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    },
  );

/**
 * Keeps only the newest page of a conversation's trace, so the next fetch reads
 * one page. Older pages cannot change, but replaying them all through the
 * per-user trace limiter on every refresh would exhaust it; they reload on demand.
 */
export function keepNewestTracePage(queryClient: QueryClient, conversationId: string): void {
  queryClient.setQueriesData<InfiniteData<TTracePage>>(
    [QueryKeys.conversationTraceRecords, conversationId],
    (data) =>
      data != null && data.pages.length > 1
        ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
        : data,
  );
}
