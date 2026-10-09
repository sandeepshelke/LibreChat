/**
 * A Stop saves the partial answer from the live content array. The calls in it
 * must carry the model response that issued them, or the next turn rebuilds the
 * rounds as one assistant message and breaks the model server's prompt cache.
 */
import { AIMessage, HumanMessage, ToolMessage } from '@librechat/agents/langchain/messages';
import type { StandardGraph, MessageContentComplex } from '@librechat/agents';

jest.spyOn(console, 'log').mockImplementation();

const toolPart = (id: string): MessageContentComplex =>
  ({
    type: 'tool_call',
    tool_call: { id, name: 'lookup', args: '{}', output: `out-${id}`, progress: 1 },
  }) as MessageContentComplex;

const runMessages = () => [
  new HumanMessage('question'),
  new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'lookup', args: {} }] }),
  new ToolMessage({ tool_call_id: 'a', content: 'out-a' }),
  new AIMessage({ content: '', tool_calls: [{ id: 'b', name: 'lookup', args: {} }] }),
  new ToolMessage({ tool_call_id: 'b', content: 'out-b' }),
];

async function configureManager() {
  const { GenerationJobManager } = await import('../GenerationJobManager');
  const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
  const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
  const jobStore = new InMemoryJobStore();
  GenerationJobManager.configure({
    jobStore,
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
    cleanupOnComplete: false,
  });
  GenerationJobManager.initialize();
  return { manager: GenerationJobManager, jobStore };
}

const tags = (content: unknown[]) =>
  (content as Array<{ response_index?: number }>).map((p) => p.response_index);

describe('abortJob tool call response tags', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('tags the aborted content from the live graph run messages', async () => {
    const { manager, jobStore } = await configureManager();
    const streamId = 'abort-tool-rounds';
    const job = await manager.createJob(streamId, 'user-1');
    const parts = [toolPart('a'), toolPart('b')];
    const graph = { getRunMessages: () => runMessages() } as unknown as StandardGraph;
    jobStore.setGraph(streamId, graph, job.createdAt);
    jobStore.setContentParts(streamId, parts, job.createdAt);

    const result = await manager.abortJob(streamId);

    expect(result.success).toBe(true);
    expect(tags(result.content)).toEqual([1, 3]);
    expect(tags(parts)).toEqual([1, 3]);
    await manager.destroy();
  });

  it('leaves content untagged when no graph is held', async () => {
    const { manager, jobStore } = await configureManager();
    const streamId = 'abort-tool-rounds-no-graph';
    const job = await manager.createJob(streamId, 'user-1');
    jobStore.setContentParts(streamId, [toolPart('a'), toolPart('b')], job.createdAt);

    const result = await manager.abortJob(streamId);

    expect(result.success).toBe(true);
    expect(tags(result.content)).toEqual([undefined, undefined]);
    await manager.destroy();
  });

  it('leaves content untagged when the graph was disposed', async () => {
    const { manager, jobStore } = await configureManager();
    const streamId = 'abort-tool-rounds-disposed';
    const job = await manager.createJob(streamId, 'user-1');
    const graph = {
      getRunMessages: () => {
        throw new TypeError('disposed');
      },
    } as unknown as StandardGraph;
    jobStore.setGraph(streamId, graph, job.createdAt);
    jobStore.setContentParts(streamId, [toolPart('a')], job.createdAt);

    const result = await manager.abortJob(streamId);

    expect(result.success).toBe(true);
    expect(tags(result.content)).toEqual([undefined]);
    await manager.destroy();
  });
});
