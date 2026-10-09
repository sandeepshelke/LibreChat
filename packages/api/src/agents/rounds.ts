import { logger } from '@librechat/data-schemas';
import { tagToolCallResponses } from '@librechat/agents';
import type { StandardGraph, MessageContentComplex } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';

type RunMessageSource = Pick<StandardGraph, 'getRunMessages'>;

/**
 * Stamps each tool call part of a saved answer with the model response that
 * issued it, so the history rebuilt on the next turn keeps one assistant
 * message per response. Skipped when the graph is missing or already disposed;
 * an untagged answer rebuilds as it always did.
 * @returns the number of parts tagged
 */
export function tagRunToolCallResponses(
  contentParts: MessageContentComplex[] | undefined,
  graph: RunMessageSource | null | undefined,
): number {
  if (graph == null || contentParts == null) {
    return 0;
  }
  let runMessages: BaseMessage[] | undefined;
  try {
    runMessages = graph.getRunMessages();
  } catch (error) {
    logger.debug('[tagRunToolCallResponses] Run messages unavailable; skipping', {
      message: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
  return tagToolCallResponses(contentParts, runMessages);
}
