import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@librechat/client';
import type { TAttachment, UIResource } from 'librechat-data-provider';
import { useMCPAppsHost, useMCPAppViewAtCapacity } from '~/Providers/MCPAppsPolicyContext';
import { selectToolCallUIResources, getInlineResourceHtml } from '~/utils/mcpApps';
import { useIsMessagesViewReadOnly } from '~/Providers/MessagesViewContext';
import { MCPAppApproval, useMCPAppApproval } from '~/hooks/MCP/approval';
import { useAppBridge, useMCPAppFrame } from '~/hooks/MCP';
import { getInlineVideoKey } from '~/utils/inlineVideo';
import { MCPAppFrame } from './MCPAppFrame';
import { useLocalize } from '~/hooks';

const DEFAULT_APP_VIEW_HEIGHT = 320;

function CapacityNotice() {
  const localize = useLocalize();
  return useMCPAppViewAtCapacity() ? (
    <span role="alert">{localize('com_ui_mcp_app_at_capacity')}</span>
  ) : null;
}

/**
 * Attachments rendered by a stable ancestor. Presentation components may still receive those
 * attachments for files, search rows, and outcome metadata; only their duplicate App view stands
 * down. Object identity keeps independently owned nested attachments visible.
 */
export const MCPAppSuppressionContext = React.createContext<ReadonlySet<TAttachment> | null>(null);

function ActiveMCPAppView({
  app,
  userId,
  close,
  closeButtonRef,
  openButtonRef,
  ordinal,
  inline = false,
  viewRef,
  onHeightChange,
}: {
  app: UIResource;
  userId: string;
  close: (restoreFocus?: boolean) => void;
  closeButtonRef: React.RefObject<HTMLButtonElement>;
  openButtonRef: React.RefObject<HTMLButtonElement>;
  ordinal: number;
  inline?: boolean;
  viewRef?: React.RefObject<HTMLDivElement>;
  onHeightChange?: (height: number) => void;
}) {
  const localize = useLocalize();
  const approval = useMCPAppApproval();
  const frame = useMCPAppFrame(app, {
    defaultHeight: DEFAULT_APP_VIEW_HEIGHT,
    toolArgs: app.toolArgs,
  });
  useLayoutEffect(() => onHeightChange?.(frame.height), [frame.height, onHeightChange]);
  useAppBridge({
    iframeRef: frame.iframeRef,
    resource: app,
    toolArgs: frame.toolArgs,
    toolResult: frame.toolResult,
    userId,
    onRequestAction: approval.request,
    onCancelAction: approval.cancel,
    attempt: frame.attempt,
    active: frame.active,
    onSizeChanged: frame.onSizeChanged,
    onLoaded: frame.onLoaded,
    onTeardown: () => {
      // A peer can tear down while the user is in its frame or approval dialog. Restore
      // their place without stealing focus if they have already moved elsewhere.
      const focusedInView =
        (viewRef?.current ?? closeButtonRef.current?.parentElement)?.contains(
          document.activeElement,
        ) ?? false;
      const focusedInApproval =
        approval.pending !== null &&
        document.activeElement?.closest('[role="alertdialog"]') != null;
      approval.cancel();
      close(focusedInView || focusedInApproval);
    },
    onFailed: frame.onFailed,
  });

  let body: React.ReactNode = null;
  if (frame.kind === 'unavailable') {
    body = (
      <div className="border-border-light bg-surface-secondary text-text-secondary my-2 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm">
        {localize('com_ui_mcp_app_shared_unavailable')}
      </div>
    );
  } else if (frame.status !== 'tornDown') {
    body = (
      <div
        className={inline ? 'relative overflow-hidden' : 'relative my-2 overflow-hidden'}
        style={{ height: frame.height }}
      >
        <MCPAppFrame
          frame={frame}
          resource={app}
          title={inline ? localize('com_ui_inline_video') : undefined}
          spinner
        />
      </div>
    );
  }
  return (
    <>
      {!inline && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          ref={closeButtonRef}
          onClick={() => close()}
          aria-label={localize('com_ui_mcp_app_close_named', {
            0: app.toolName,
            1: String(ordinal),
          })}
        >
          {localize('com_ui_mcp_app_close')}
        </Button>
      )}
      {body}
      <MCPAppApproval
        action={approval.pending}
        approve={approval.approve}
        cancel={approval.cancel}
        close={() => {
          approval.cancel();
          close();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // The dialog has no persistent trigger. Return focus to the host View control.
          (openButtonRef.current ?? closeButtonRef.current ?? viewRef?.current)?.focus();
        }}
      />
    </>
  );
}

function InlineVideoView({ app, userId }: { app: UIResource; userId: string }) {
  const localize = useLocalize();
  const { reserveView, releaseView } = useMCPAppsHost();
  const atCapacity = useMCPAppViewAtCapacity();
  const readOnly = useIsMessagesViewReadOnly();
  // Saved jobs use the current player, while shared transcripts retain their inert snapshot.
  const player = useMemo(
    () => (readOnly ? app : { ...app, text: undefined, blob: undefined }),
    [app, readOnly],
  );
  const unavailable = readOnly && !getInlineResourceHtml(app);
  const viewKey = useId();
  const viewRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [opened, setOpened] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [height, setHeight] = useState(DEFAULT_APP_VIEW_HEIGHT);

  useEffect(() => {
    if (!viewRef.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(viewRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || unavailable) {
      releaseView(viewKey);
      setOpened(false);
    } else if (!opened && !dismissed && reserveView(viewKey)) {
      setOpened(true);
    }
  }, [visible, unavailable, opened, dismissed, atCapacity, reserveView, releaseView, viewKey]);
  useEffect(() => () => releaseView(viewKey), [releaseView, viewKey]);
  const close = useCallback(
    (restoreFocus = false) => {
      setDismissed(true);
      setOpened(false);
      releaseView(viewKey);
      if (restoreFocus) viewRef.current?.focus();
    },
    [releaseView, viewKey],
  );

  let placeholder: React.ReactNode = <span role="status">{localize('com_ui_loading_video')}</span>;
  if (unavailable) {
    placeholder = localize('com_ui_mcp_app_shared_unavailable');
  } else if (dismissed) {
    placeholder = (
      <Button ref={buttonRef} onClick={() => setDismissed(false)}>
        {localize('com_ui_load_video')}
      </Button>
    );
  } else if (atCapacity && visible) {
    placeholder = <CapacityNotice />;
  }
  return (
    <div
      ref={viewRef}
      tabIndex={-1}
      className="my-2"
      data-inline-video
      aria-label={localize('com_ui_inline_video')}
    >
      {opened ? (
        <ActiveMCPAppView
          app={player}
          userId={userId}
          close={close}
          closeButtonRef={buttonRef}
          openButtonRef={buttonRef}
          viewRef={viewRef}
          onHeightChange={setHeight}
          ordinal={1}
          inline
        />
      ) : (
        <div
          style={{ height }}
          className="text-text-secondary flex items-center justify-center text-sm"
        >
          {placeholder}
        </div>
      )}
    </div>
  );
}

const MCPAppView = React.memo(function MCPAppView({
  app,
  userId,
  ordinal,
}: {
  app: UIResource;
  userId: string;
  ordinal: number;
}) {
  const localize = useLocalize();
  const { reserveView, releaseView } = useMCPAppsHost();
  const readOnly = useIsMessagesViewReadOnly();
  const unavailable = readOnly && !getInlineResourceHtml(app);
  const viewKey = useId();
  const [opened, setOpened] = useState(false);
  const [atCapacity, setAtCapacity] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterTransition = useRef<'open' | 'close' | null>(null);
  useLayoutEffect(() => {
    const target = focusAfterTransition.current;
    if (!target) return;
    const button = target === 'open' ? openButtonRef.current : closeButtonRef.current;
    if (button) {
      focusAfterTransition.current = null;
      button.focus();
    }
  }, [opened]);
  useEffect(() => {
    if (unavailable) {
      releaseView(viewKey);
      setOpened(false);
    }
  }, [unavailable, releaseView, viewKey]);
  const close = useCallback(
    (restoreFocus = true) => {
      focusAfterTransition.current = restoreFocus ? 'open' : null;
      releaseView(viewKey);
      setOpened(false);
      setAtCapacity(false);
    },
    [releaseView, viewKey],
  );
  useEffect(
    () => () => {
      releaseView(viewKey);
    },
    [releaseView, viewKey],
  );
  const open = () => {
    if (unavailable) return;
    const reserved = reserveView(viewKey);
    if (!reserved) {
      setAtCapacity(true);
      return;
    }
    focusAfterTransition.current = 'close';
    setAtCapacity(false);
    setOpened(true);
  };
  if (unavailable) {
    return (
      <div
        className="border-border-light bg-surface-secondary text-text-secondary my-2 rounded-lg border px-4 py-3 text-sm"
        data-mcp-app-view={app.toolName}
      >
        {localize('com_ui_mcp_app_shared_unavailable')}
      </div>
    );
  }
  return (
    <div className="my-2" data-mcp-app-view={app.toolName}>
      {opened ? (
        <ActiveMCPAppView
          app={app}
          userId={userId}
          close={close}
          closeButtonRef={closeButtonRef}
          openButtonRef={openButtonRef}
          ordinal={ordinal}
        />
      ) : (
        <div className="border-border-light bg-surface-secondary text-text-secondary flex min-h-16 items-center gap-3 rounded-lg border px-4 py-3 text-sm">
          <span className="min-w-0 flex-1 truncate">{app.toolName}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            ref={openButtonRef}
            onClick={open}
            aria-label={localize('com_ui_mcp_app_open_named', {
              0: app.toolName,
              1: String(ordinal),
            })}
          >
            {localize('com_ui_mcp_app_open')}
          </Button>
          {atCapacity && <CapacityNotice />}
        </div>
      )}
    </div>
  );
});

export function MCPAppViews({ attachments }: { attachments?: TAttachment[] }) {
  const suppressedAttachments = React.useContext(MCPAppSuppressionContext);
  const { policy, userId } = useMCPAppsHost();
  const visibleAttachments = useMemo(
    () =>
      suppressedAttachments == null
        ? attachments
        : attachments?.filter((attachment) => !suppressedAttachments.has(attachment)),
    [attachments, suppressedAttachments],
  );
  const apps = useMemo(() => {
    const seen = new Set<string>();
    return selectToolCallUIResources(visibleAttachments).flatMap((occurrence) => {
      const videoKey = getInlineVideoKey(occurrence.resource, policy.inlineVideoServers);
      if (videoKey && seen.has(videoKey)) return [];
      if (videoKey) seen.add(videoKey);
      return [{ ...occurrence, key: videoKey ?? occurrence.key, inline: !!videoKey }];
    });
  }, [visibleAttachments, policy.inlineVideoServers]);

  if (!policy.enabled || !userId || apps.length === 0) {
    return null;
  }

  return (
    <>
      {apps.map(({ key, resource, inline }, index) =>
        inline ? (
          <InlineVideoView key={JSON.stringify([userId, key])} app={resource} userId={userId} />
        ) : (
          <MCPAppView
            key={JSON.stringify([userId, key])}
            app={resource}
            userId={userId}
            ordinal={index + 1}
          />
        ),
      )}
    </>
  );
}
