import type { TTurnDiagnostics } from 'librechat-data-provider';
import { Providers } from '@librechat/agents';
import { logToolError } from '~/agents/client';
import type { FetchLike, ModelOrigin, TurnDiagnostics, TurnSnapshotState } from './capture';

/** What the controller knows when it takes the snapshot that goes on the saved response. */
export type TurnOutcomeInput = {
  /** A state the caller already decided, e.g. `failed` for the error row that stands in. */
  state?: TurnSnapshotState;
  aborted?: boolean;
  pendingApproval?: boolean;
  /** The run ended on a model or framework error that was shown to the user. */
  terminalError?: boolean;
  /** The graph ran out of its step budget. */
  stepLimitReached?: boolean;
};

/** Cancellation and approval pauses outrank a failure, which outranks a step limit. */
export function resolveTurnState(input: TurnOutcomeInput): TurnSnapshotState {
  if (input.state != null) {
    return input.state;
  }
  if (input.pendingApproval === true) {
    return 'paused';
  }
  if (input.aborted === true) {
    return 'cancelled';
  }
  if (input.terminalError === true) {
    return 'failed';
  }
  return input.stepLimitReached === true ? 'incomplete' : 'completed';
}

/** The message fields that persist this turn's diagnostics, `{}` when the feature is off. */
export function turnDiagnosticsFields(
  diagnostics: TurnDiagnostics | null | undefined,
  input: TurnOutcomeInput & { messageId?: string },
): { turnDiagnostics?: TTurnDiagnostics } {
  if (diagnostics == null) {
    return {};
  }
  return { turnDiagnostics: diagnostics.snapshot(resolveTurnState(input), input.messageId) };
}

type Logger = { warn: (message: string, meta?: Record<string, unknown>) => void };

/**
 * Continues the stored snapshot of a resumed turn. A failed read means earlier segments are
 * missing, so the turn is marked as not fully captured rather than presented as complete.
 */
export async function restoreTurnDiagnostics(
  diagnostics: TurnDiagnostics | null | undefined,
  load: () => Promise<{ diagnostics?: TTurnDiagnostics | null } | undefined>,
  logger?: Logger,
): Promise<void> {
  if (diagnostics == null) {
    return;
  }
  try {
    const stored = await load();
    if (stored?.diagnostics == null) {
      diagnostics.note('capture_failed');
      return;
    }
    diagnostics.seed(stored.diagnostics);
  } catch (error) {
    diagnostics.note('capture_failed');
    logger?.warn('[turn-diagnostics] Stored diagnostics could not be restored', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

/** Logs a tool failure and, when diagnostics are on, records its class on the turn. */
export function createToolErrorCallback(
  diagnostics: TurnDiagnostics | null | undefined,
): (graph: unknown, error: unknown, toolId: string) => void {
  if (diagnostics == null) {
    return logToolError;
  }
  return (graph, error, toolId) => {
    logToolError(graph, error, toolId);
    diagnostics.tools.failed({ id: toolId, error });
  };
}

export type DiagnosticsFetchContext = { model?: string; agentId?: string; origin?: ModelOrigin };

/**
 * Routes an OpenAI-compatible client's HTTP calls through the turn diagnostics meter, keeping a
 * fetch the configuration already sets. Fallback clients are metered too.
 */
export function withDiagnosticsFetch<T extends object>(
  options: T,
  diagnostics: TurnDiagnostics | undefined,
  context: DiagnosticsFetchContext = {},
): T {
  if (diagnostics == null) {
    return options;
  }
  const target = options as T & {
    model?: string;
    configuration?: { fetch?: FetchLike };
    fallbacks?: Array<{ clientOptions?: object }>;
  };
  const configuration = target.configuration ?? {};
  const wrapped = {
    ...target,
    configuration: {
      ...configuration,
      fetch: diagnostics.wrapFetch(configuration.fetch, {
        ...context,
        model: context.model ?? target.model,
      }),
    },
  };
  if (Array.isArray(target.fallbacks)) {
    wrapped.fallbacks = target.fallbacks.map((fallback) => ({
      ...fallback,
      clientOptions: withDiagnosticsFetch(
        { ...(fallback.clientOptions ?? {}) },
        diagnostics,
        context,
      ),
    }));
  }
  return wrapped;
}

/** Saves a snapshot refreshed after the response was already written, e.g. once its title ran. */
export async function persistSettledDiagnostics(
  diagnostics: TurnDiagnostics | null | undefined,
  save: (fields: { messageId: string; turnDiagnostics: TTurnDiagnostics }) => Promise<unknown>,
  logger?: Logger,
): Promise<void> {
  const settled = diagnostics?.settled();
  if (diagnostics == null || settled == null || settled.messageId === '') {
    return;
  }
  try {
    const turnDiagnostics = diagnostics.snapshot(settled.state, settled.messageId);
    await save({ messageId: turnDiagnostics.turn.messageId, turnDiagnostics });
  } catch (error) {
    logger?.warn('[turn-diagnostics] Late diagnostics were not saved', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

/** Meters the title model's calls under their own origin; a provider this layer cannot see into is noted. */
export function withTitleDiagnostics<T extends object>(
  options: T,
  diagnostics: TurnDiagnostics | null | undefined,
  provider: string | undefined,
): T {
  if (diagnostics == null) {
    return options;
  }
  if (provider !== Providers.OPENAI) {
    diagnostics.note('models_not_captured');
    return options;
  }
  return withDiagnosticsFetch(options, diagnostics, { origin: 'title' });
}
