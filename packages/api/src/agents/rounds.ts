import { logger } from '@librechat/data-schemas';
import { tagToolCallResponses } from '@librechat/agents';
import { getSafeErrorMetadata } from '~/utils/errors';
import type { StandardGraph, MessageContentComplex } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';

type RunMessageSource = Pick<StandardGraph, 'getRunMessages'>;

/** True when a saved answer has a tool call, the only parts that get a tag. */
export function hasToolCallPart(
  contentParts: ReadonlyArray<MessageContentComplex | undefined> | undefined,
): boolean {
  if (contentParts == null) {
    return false;
  }
  for (let i = 0; i < contentParts.length; i++) {
    if (contentParts[i]?.type === 'tool_call') {
      return true;
    }
  }
  return false;
}

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
  if (graph == null || !hasToolCallPart(contentParts)) {
    return 0;
  }
  let runMessages: BaseMessage[] | undefined;
  try {
    runMessages = graph.getRunMessages();
  } catch (error) {
    logger.warn(
      '[tagRunToolCallResponses] Run messages unavailable; skipping',
      getSafeErrorMetadata(error),
    );
    return 0;
  }
  return tagToolCallResponses(contentParts, runMessages);
}
