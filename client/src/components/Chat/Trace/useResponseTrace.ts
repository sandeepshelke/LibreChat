import { useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { Constants, resolveTraceViewerConfig } from 'librechat-data-provider';
import { useGetStartupConfig, useConversationTraceAvailabilityQuery } from '~/data-provider';
import { traceViewerConversationAtom, traceViewerFocusAtom } from './store';

export const UNPERSISTED_IDS = new Set(
  [Constants.NEW_CONVO, Constants.PENDING_CONVO, Constants.SEARCH].map(String),
);

/** Opens the existing trace viewer narrowed to one response. */
export function useOpenResponseTrace(conversationId: string | null | undefined, messageId: string) {
  const setConversation = useSetAtom(traceViewerConversationAtom);
  const setFocus = useSetAtom(traceViewerFocusAtom);
  return useCallback(() => {
    if (conversationId == null) {
      return;
    }
    setFocus(messageId);
    setConversation(conversationId);
  }, [conversationId, messageId, setConversation, setFocus]);
}

/**
 * The per-response entry to locally captured diagnostics. It offers itself only for a
 * settled response the server says has diagnostics, and opens the trace narrowed to it.
 */
export default function useResponseTrace({
  conversationId,
  messageId,
  enabled,
}: {
  conversationId?: string | null;
  messageId: string;
  enabled: boolean;
}): { show: boolean; open: () => void } {
  const { data: startupConfig } = useGetStartupConfig();
  const settings = resolveTraceViewerConfig(startupConfig?.interface?.traceViewer);
  const open = useOpenResponseTrace(conversationId, messageId);
  const eligible =
    enabled &&
    settings.enabled &&
    settings.source === 'local' &&
    conversationId != null &&
    !UNPERSISTED_IDS.has(conversationId);
  const { data } = useConversationTraceAvailabilityQuery(conversationId ?? '', {
    enabled: eligible,
  });
  return {
    show: eligible && data?.available === true && data.messageIds?.includes(messageId) === true,
    open,
  };
}
