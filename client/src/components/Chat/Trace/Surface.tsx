import { useEffect } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import type { ReactNode } from 'react';
import { traceViewerConversationAtom, traceViewerFocusAtom } from './store';
import Viewer from './Viewer';
import { cn } from '~/utils';

/**
 * Hosts the trace over the chat without unmounting it: the chat stays mounted
 * and inert underneath, so closing the trace restores its scroll position,
 * composer draft and focus target exactly as they were.
 */
export default function TraceSurface({
  conversationId,
  children,
}: {
  conversationId?: string | null;
  children: ReactNode;
}) {
  const [traceConversationId, setTraceConversationId] = useAtom(traceViewerConversationAtom);
  const setFocus = useSetAtom(traceViewerFocusAtom);
  const open = conversationId != null && traceConversationId === conversationId;

  useEffect(() => {
    if (traceConversationId != null && traceConversationId !== conversationId) {
      setTraceConversationId(null);
    }
  }, [conversationId, traceConversationId, setTraceConversationId]);

  const close = () => {
    setFocus(null);
    setTraceConversationId(null);
  };

  return (
    <div className="relative flex h-full w-full flex-col">
      {/* `isolate` while covered: the chat's own layers (the message rail sits at
          z-40) would otherwise stack above the trace. */}
      <div
        className={cn('flex h-full w-full flex-col', open && 'isolate')}
        inert={open ? '' : undefined}
      >
        {children}
      </div>
      {open && <Viewer conversationId={conversationId} onClose={close} />}
    </div>
  );
}
