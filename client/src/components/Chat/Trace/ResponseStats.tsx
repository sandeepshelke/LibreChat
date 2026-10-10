import {
  memo,
  useRef,
  useMemo,
  useState,
  useEffect,
  useContext,
  useCallback,
  createContext,
} from 'react';
import { useAtomValue } from 'jotai';
import { Info } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, TooltipAnchor, useToastContext } from '@librechat/client';
import { QueryKeys, resolveTraceViewerConfig } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TResponseStats } from 'librechat-data-provider';
import { useGetStartupConfig, useConversationResponseStatsQuery } from '~/data-provider';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import { UNPERSISTED_IDS, useOpenResponseTrace } from './useResponseTrace';
import { hoverButtonClasses } from '../Messages/styles';
import { statsLine, statsRows, rowsToHtml } from './stats';
import { traceErrorCode } from './errors';
import { useLocalize } from '~/hooks';

/** Null means the feature is off for this conversation: nothing is fetched or rendered. */
const ResponseStatsContext = createContext<ReadonlyMap<string, TResponseStats> | null>(null);

/**
 * When a settled answer's row is still missing from the refreshed stats, the save may have landed
 * after the terminal event; ask again this many milliseconds later, once per entry.
 */
const SETTLE_RETRY_MS = [1000, 3000] as const;

type Settling = {
  id: string;
  messageId?: string | null;
  paused: boolean;
  since: number;
  attempts: number;
};

/**
 * The one subscription to a conversation's response stats. Rows only read the map it provides.
 * A run that settles or pauses refreshes it once, replacing any older request still in flight;
 * if the newest answer is still absent afterwards, a bounded retry asks again for that answer.
 */
export function ResponseStatsProvider({
  conversationId,
  isSubmitting,
  expectedMessageId,
  children,
}: {
  conversationId?: string | null;
  isSubmitting: boolean;
  /** The conversation's newest answer, which a settled run should have stats for. */
  expectedMessageId?: string | null;
  children: ReactNode;
}) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: startupConfig } = useGetStartupConfig();
  const settings = resolveTraceViewerConfig(startupConfig?.interface?.traceViewer);
  const id = conversationId ?? '';
  const eligible =
    settings.enabled &&
    settings.source === 'local' &&
    conversationId != null &&
    !UNPERSISTED_IDS.has(conversationId);
  const { data, isError, isFetching, error, dataUpdatedAt, errorUpdatedAt } =
    useConversationResponseStatsQuery(id, eligible);

  const queryClient = useQueryClient();
  const paused = useAtomValue(pendingApprovalActionFamily(eligible ? id : '')) != null;
  const previous = useRef({ id, busy: isSubmitting, paused });
  const settling = useRef<Settling | null>(null);
  const scheduled = useRef<string | null>(null);
  const active = useRef<string | null>(null);

  useEffect(() => {
    active.current = eligible ? id : null;
    return () => {
      active.current = null;
    };
  }, [eligible, id]);

  /**
   * An older request still in flight may have read before the save landed, and a first fetch has
   * no data for the query to cancel on its own, so it is cancelled explicitly before refetching.
   */
  const refresh = useCallback(async () => {
    if (active.current !== id) {
      return;
    }
    const key = [QueryKeys.conversationResponseStats, id];
    await queryClient.cancelQueries(key);
    if (active.current === id) {
      await queryClient.invalidateQueries(key);
    }
  }, [queryClient, id]);

  /** A pause and the run ending can land in separate renders of one task; they ask once. */
  const refreshOnce = useCallback(() => {
    if (scheduled.current === id) {
      return;
    }
    scheduled.current = id;
    queueMicrotask(() => {
      if (scheduled.current === id) {
        scheduled.current = null;
      }
      void refresh();
    });
  }, [id, refresh]);

  useEffect(() => {
    const last = previous.current;
    previous.current = { id, busy: isSubmitting, paused };
    if (last.id !== id || !eligible) {
      settling.current = null;
      return;
    }
    if (isSubmitting && !paused) {
      settling.current = null;
    }
    if (!((last.busy && !isSubmitting) || (!last.paused && paused))) {
      return;
    }
    settling.current = { id, messageId: expectedMessageId, paused, since: Date.now(), attempts: 0 };
    refreshOnce();
  }, [isSubmitting, paused, eligible, id, expectedMessageId, refreshOnce]);

  const map = useMemo(
    () =>
      eligible && !isError && data != null
        ? new Map(data.summaries.map((stats) => [stats.messageId, stats]))
        : null,
    [eligible, isError, data],
  );

  useEffect(() => {
    const wait = settling.current;
    if (
      !eligible ||
      isError ||
      wait == null ||
      wait.id !== id ||
      isFetching ||
      dataUpdatedAt < wait.since
    ) {
      return;
    }
    const messageId = wait.messageId ?? expectedMessageId;
    const summary = messageId != null ? map?.get(messageId) : undefined;
    if (messageId == null || (summary != null && (wait.paused || summary.state !== 'paused'))) {
      settling.current = null;
      return;
    }
    const delay = SETTLE_RETRY_MS[wait.attempts];
    if (delay == null) {
      settling.current = null;
      return;
    }
    const timer = setTimeout(() => {
      if (settling.current !== wait) {
        return;
      }
      wait.attempts++;
      wait.since = Date.now();
      void refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [map, isFetching, isError, eligible, dataUpdatedAt, expectedMessageId, id, refresh]);

  const reported = useRef('');
  useEffect(() => {
    const failure = `${id}:${errorUpdatedAt}`;
    if (!eligible || !isError || reported.current === failure) {
      return;
    }
    reported.current = failure;
    showToast({
      message: localize(
        traceErrorCode(error) === 'rate_limited'
          ? 'com_ui_trace_error_rate_limited'
          : 'com_ui_response_stats_error',
      ),
      status: 'error',
    });
  }, [eligible, isError, error, errorUpdatedAt, id, showToast, localize]);

  return <ResponseStatsContext.Provider value={map}>{children}</ResponseStatsContext.Provider>;
}

export const useResponseStat = (messageId: string): TResponseStats | undefined =>
  useContext(ResponseStatsContext)?.get(messageId);

/** Hover or focus for statistics; Enter or a click opens the full diagnostics viewer. */
function ResponseStatsButton({
  conversationId,
  messageId,
  alwaysVisible,
  className,
}: {
  conversationId?: string | null;
  messageId: string;
  alwaysVisible: boolean;
  className?: string;
}) {
  const localize = useLocalize();
  const stats = useResponseStat(messageId);
  const open = useOpenResponseTrace(conversationId, messageId);
  const [armed, setArmed] = useState(false);
  const arm = useCallback(() => setArmed(true), []);
  const language = typeof navigator === 'undefined' ? undefined : navigator.language;

  const tooltip = useMemo(
    () =>
      armed && stats
        ? rowsToHtml(
            [statsLine(stats, localize, language), ...statsRows(stats, localize, language)].filter(
              Boolean,
            ),
          )
        : '',
    [armed, stats, localize, language],
  );

  if (!stats) {
    return null;
  }

  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={localize('com_ui_response_stats_label')}
      data-testid="response-stats-button"
      onClick={open}
      className={hoverButtonClasses({ isLast: alwaysVisible, className })}
    >
      <Info size={19} aria-hidden="true" />
    </Button>
  );

  return (
    <TooltipAnchor
      description={tooltip}
      enableHTML
      side="bottom"
      render={button}
      onFocus={arm}
      onMouseEnter={arm}
      onTouchStart={arm}
    />
  );
}

export default memo(ResponseStatsButton);
