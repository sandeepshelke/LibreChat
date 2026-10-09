import { AIMessage, HumanMessage, ToolMessage } from '@librechat/agents/langchain/messages';
import type { MessageContentComplex } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import { tagRunToolCallResponses, hasToolCallPart } from './rounds';

const toolPart = (id: string, response_index?: number): MessageContentComplex =>
  ({
    type: 'tool_call',
    tool_call: { id, name: 'lookup', args: '{}', output: `out-${id}` },
    ...(response_index != null && { response_index }),
  }) as MessageContentComplex;

const runMessages = () => [
  new HumanMessage('question'),
  new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'lookup', args: {} }] }),
  new ToolMessage({ tool_call_id: 'a', content: 'out-a' }),
  new AIMessage({
    content: '',
    tool_calls: [
      { id: 'b', name: 'lookup', args: {} },
      { id: 'c', name: 'lookup', args: {} },
    ],
  }),
  new ToolMessage({ tool_call_id: 'b', content: 'out-b' }),
  new ToolMessage({ tool_call_id: 'c', content: 'out-c' }),
];

const tags = (parts: MessageContentComplex[]) =>
  parts.map((p) => (p as { response_index?: number }).response_index);

describe('tagRunToolCallResponses', () => {
  it('tags parts from the graph run messages', () => {
    const parts = [toolPart('a'), toolPart('b'), toolPart('c')];
    const graph = { getRunMessages: jest.fn(() => runMessages()) };
    expect(tagRunToolCallResponses(parts, graph)).toBe(3);
    expect(tags(parts)).toEqual([1, 3, 3]);
    expect(graph.getRunMessages).toHaveBeenCalledTimes(1);
  });

  it('skips tagging without a graph or content', () => {
    const parts = [toolPart('a')];
    expect(tagRunToolCallResponses(parts, undefined)).toBe(0);
    expect(tagRunToolCallResponses(parts, null)).toBe(0);
    expect(tagRunToolCallResponses(undefined, { getRunMessages: () => runMessages() })).toBe(0);
    expect(tags(parts)).toEqual([undefined]);
  });

  it('skips tagging when the graph was disposed or has no run messages', () => {
    const parts = [toolPart('a', 2)];
    const disposed = {
      getRunMessages: () => {
        throw new TypeError("Cannot read properties of null (reading 'slice')");
      },
    };
    expect(tagRunToolCallResponses(parts, disposed)).toBe(0);
    expect(tagRunToolCallResponses(parts, { getRunMessages: () => undefined })).toBe(0);
    expect(tags(parts)).toEqual([2]);
  });

  it('keeps earlier tags for calls the rebuilt graph no longer holds', () => {
    const parts = [toolPart('x', 1), toolPart('y', 3), toolPart('b'), toolPart('c')];
    tagRunToolCallResponses(parts, { getRunMessages: () => runMessages() });
    expect(tags(parts)).toEqual([1, 3, 7, 7]);
  });

  it('does not read run messages when the answer has no tool calls', () => {
    const graph = { getRunMessages: jest.fn(() => runMessages()) };
    const parts = [{ type: 'text', text: 'hi' }] as MessageContentComplex[];
    expect(tagRunToolCallResponses(parts, graph)).toBe(0);
    expect(tagRunToolCallResponses([], graph)).toBe(0);
    expect(graph.getRunMessages).not.toHaveBeenCalled();
  });

  it('logs only safe metadata when the graph throws', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation();
    const secret = 'prompt text sk-secret-123';
    const graph = {
      getRunMessages: () => {
        throw new Error(secret);
      },
    };
    expect(tagRunToolCallResponses([toolPart('a')], graph)).toBe(0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    warn.mockRestore();
  });

  it('detects tool call parts', () => {
    expect(hasToolCallPart(undefined)).toBe(false);
    expect(hasToolCallPart([undefined, { type: 'text', text: 'x' } as MessageContentComplex])).toBe(
      false,
    );
    expect(hasToolCallPart([toolPart('a')])).toBe(true);
  });
});
