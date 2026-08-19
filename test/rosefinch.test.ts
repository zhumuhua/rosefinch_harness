import { describe, expect, it } from 'vitest';

import { EventLog } from '../src/event-log.ts';
import { Dispatch } from '../src/dispatch.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { executeToolCalls } from '../src/scheduler.ts';
import { Agent } from '../src/agent.ts';
import { Compactor } from '../src/compactor.ts';
import { estimateMessages, estimateTokens } from '../src/tokens.ts';
import { fakeAdapter } from '../src/llm/fake.ts';
import type { LlmAdapter, LlmContext } from '../src/llm/types.ts';
import type { AgentHandle, ToolDefinition, ToolExecutionMode } from '../src/tools/types.ts';
import type { AssistantMessage, ToolCall, UserMessage } from '../src/types.ts';

const handle: AgentHandle = { id: 'test', inject: () => {} };

function userMessage(text: string): UserMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'fake',
    model: 'fake-1',
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

describe('EventLog', () => {
  it('keeps a monotonic sequence and derives model-visible history in order', () => {
    const log = new EventLog();
    const u = userMessage('hi');
    log.append({ type: 'turn/start', turn: 1 });
    log.append({ type: 'user/message', turn: 1, step: 1, message: u });
    log.append({
      type: 'assistant/message',
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        provider: 'fake',
        model: 'fake-1',
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    });

    expect(log.seq).toBe(3);
    expect(log.deriveMessages()).toHaveLength(2);
    expect(log.deriveMessages()[0]).toBe(u);
    expect(log.findLast((e) => e.type === 'user/message')?.type).toBe('user/message');
  });

  it('replays existing events to a late subscriber', () => {
    const log = new EventLog();
    log.append({ type: 'turn/start', turn: 7 });
    const seen: number[] = [];
    log.subscribe(({ seq }) => seen.push(seq));
    expect(seen).toEqual([1]);
  });
});

describe('Dispatch', () => {
  it('waterfalls pre-step: a handler may reject', async () => {
    const dispatch = new Dispatch();
    const disposer = dispatch.onPreStep((_ctx, decision) =>
      decision.kind === 'enter' && decision.messages.length > 0
        ? { kind: 'reject', reason: 'blocked' }
        : decision,
    );
    const messages = [userMessage('x')];
    const result = await dispatch.runPreStep(
      { turn: 1, step: 1, messages, signal: new AbortController().signal },
      { kind: 'enter', messages },
    );
    expect(result.kind).toBe('reject');
    disposer();
  });

  it('waterfalls request: a handler may rewrite config', async () => {
    const dispatch = new Dispatch();
    dispatch.onRequest((_ctx, config) => ({ ...config, model: 'override' }));
    const config = await dispatch.runRequest(
      { turn: 1, step: 1, signal: new AbortController().signal },
      { provider: 'fake', model: 'fake-1', system: '', tools: [] },
    );
    expect(config.model).toBe('override');
  });

  it('request-error returns true only when a handler requests retry', async () => {
    const dispatch = new Dispatch();
    expect(
      await dispatch.runRequestError({
        turn: 1,
        step: 1,
        failure: { message: 'boom', code: 'X' },
        signal: new AbortController().signal,
      }),
    ).toBe(false);

    dispatch.onRequestError(() => ({ kind: 'retry' }));
    expect(
      await dispatch.runRequestError({
        turn: 1,
        step: 1,
        failure: { message: 'boom', code: 'X' },
        signal: new AbortController().signal,
      }),
    ).toBe(true);
  });
});

describe('Tool scheduler', () => {
  function trackedTool(name: string, mode: ToolExecutionMode, track: { max: number; calls: number; active: number }) {
    const tool: ToolDefinition = {
      name,
      description: '',
      parameters: { type: 'object', properties: {} },
      executionMode: mode,
      async execute() {
        track.calls += 1;
        track.active += 1;
        track.max = Math.max(track.max, track.active);
        await new Promise((r) => setTimeout(r, 15));
        track.active -= 1;
        return { content: [{ type: 'text', text: name }], isError: false };
      },
    };
    return tool;
  }

  function run(registry: ToolRegistry, toolCalls: ToolCall[], signal: AbortSignal, maxParallelToolCalls: number) {
    return executeToolCalls({
      log: new EventLog(),
      registry,
      agent: handle,
      turn: 1,
      step: 1,
      toolCalls,
      signal,
      maxParallelToolCalls,
      acceptContext: () => {},
    });
  }

  it('bounds the parallel pool to maxParallelToolCalls', async () => {
    const registry = new ToolRegistry();
    const track = { max: 0, calls: 0, active: 0 };
    for (const name of ['a', 'b', 'c']) registry.register(trackedTool(name, 'parallel', track));

    await run(
      registry,
      [
        { id: '1', name: 'a', arguments: '{}' },
        { id: '2', name: 'b', arguments: '{}' },
        { id: '3', name: 'c', arguments: '{}' },
      ],
      new AbortController().signal,
      2,
    );

    expect(track.calls).toBe(3);
    expect(track.max).toBe(2);
  });

  it('runs a sequential tool as an exclusive barrier', async () => {
    const registry = new ToolRegistry();
    const track = { max: 0, calls: 0, active: 0 };
    registry.register(trackedTool('seq', 'sequential', track));
    registry.register(trackedTool('par', 'parallel', track));

    await run(
      registry,
      [
        { id: '1', name: 'seq', arguments: '{}' },
        { id: '2', name: 'par', arguments: '{}' },
      ],
      new AbortController().signal,
      5,
    );

    expect(track.calls).toBe(2);
    expect(track.max).toBe(1);
  });

  it('writes synthetic skipped results on abort', async () => {
    const registry = new ToolRegistry();
    const track = { max: 0, calls: 0, active: 0 };
    registry.register(trackedTool('a', 'parallel', track));
    registry.register(trackedTool('b', 'parallel', track));

    const log = new EventLog();
    const controller = new AbortController();
    controller.abort();

    await executeToolCalls({
      log,
      registry,
      agent: handle,
      turn: 1,
      step: 1,
      toolCalls: [
        { id: '1', name: 'a', arguments: '{}' },
        { id: '2', name: 'b', arguments: '{}' },
      ],
      signal: controller.signal,
      maxParallelToolCalls: 4,
      acceptContext: () => {},
    });

    expect(track.calls).toBe(0);
    const results = log.deriveMessages().filter((m) => m.role === 'toolResult');
    expect(results).toHaveLength(2);
    expect(results.every((m) => m.role === 'toolResult' && m.isError)).toBe(true);
  });
});

describe('agent e2e', () => {
  it('runs a scripted tool call then answers, and log matches projection', async () => {
    const adapter = fakeAdapter({
      replies: [
        { toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"Beijing"}' }] },
        { text: 'Beijing is 22C and clear.' },
      ],
    });

    const agent = new Agent({
      model: { provider: 'fake', id: 'fake-1', contextWindow: 4000, maxTokens: 256 },
      adapter,
    });

    let executions = 0;
    agent.tools.register({
      name: 'get_weather',
      description: '',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      execute({ arguments: args }) {
        executions += 1;
        const { city } = args as { city?: string };
        return {
          content: [{ type: 'text', text: `${city}: 22C, clear` }],
          isError: false,
          additionalContext: [userMessage('Now answer the user.')],
        };
      },
    });

    await agent.prompt("What's the weather in Beijing?");

    expect(executions).toBe(1);
    const roles = agent.projection.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'toolResult', 'user', 'assistant']);

    const final = agent.projection.messages.at(-1);
    expect(final?.role).toBe('assistant');
    if (final?.role === 'assistant') {
      expect(final.content.some((b) => b.type === 'text' && b.text.includes('22C'))).toBe(true);
    }

    // model-visible ⟺ logged: projection agrees with deriveMessages().
    expect(agent.projection.messages).toEqual(agent.log.deriveMessages());
  });

  it('auto-continues after a tool call without manual bridging', async () => {
    const adapter = fakeAdapter({
      replies: [
        { toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"Beijing"}' }] },
        { text: 'Beijing is 22C and clear.' },
      ],
    });

    const agent = new Agent({
      model: { provider: 'fake', id: 'fake-1', contextWindow: 4000, maxTokens: 256 },
      adapter,
    });

    agent.tools.register({
      name: 'get_weather',
      description: '',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      execute() {
        return { content: [{ type: 'text', text: 'Beijing: 22C, clear' }], isError: false };
      },
    });

    await agent.prompt("What's the weather in Beijing?");

    expect(agent.projection.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
    const final = agent.projection.messages.at(-1);
    if (final?.role === 'assistant') {
      expect(final.content.some((b) => b.type === 'text' && b.text.includes('22C'))).toBe(true);
    }
  });

  it('streams text deltas to dispatch subscribers', async () => {
    const adapter: LlmAdapter = async function* () {
      yield { type: 'text_delta', delta: 'Hel' };
      yield { type: 'text_delta', delta: 'lo' };
      yield { type: 'done', stopReason: 'stop' };
    };
    const agent = new Agent({
      model: { provider: 'fake', id: 'fake-1', contextWindow: 4000, maxTokens: 256 },
      adapter,
    });

    const deltas: string[] = [];
    agent.dispatch.on('text/delta', (e) => {
      deltas.push(e.delta);
    });

    await agent.prompt('hi');
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('compacts overflowing history via the maintenance phase', async () => {
    const seen: LlmContext[] = [];
    const base = fakeAdapter({
      replies: [
        { text: 'CONVERSATION SUMMARY' },
        { text: 'I remember: the sky is blue.' },
      ],
    });
    const adapter: LlmAdapter = (model, ctx, opts) => {
      seen.push(ctx);
      return base(model, ctx, opts);
    };

    const agent = new Agent({
      model: { provider: 'fake', id: 'fake-1', contextWindow: 400, maxTokens: 256 },
      adapter,
      compaction: { triggerTokens: 30, keepRecent: 1 },
    });

    for (let i = 0; i < 4; i++) {
      agent.log.append({
        type: 'user/message',
        turn: 0,
        step: 0,
        message: userMessage(`history q${i} with a fairly long sentence to overflow`),
      });
      agent.log.append({
        type: 'assistant/message',
        turn: 0,
        step: 0,
        message: assistantMessage(`history a${i} also somewhat long for the budget`),
      });
    }

    await agent.prompt('What color is the sky?');

    expect(seen).toHaveLength(2);
    expect(seen[0].messages).toHaveLength(8);
    expect(seen[1].messages).toHaveLength(2);
    const summary = seen[1].messages[0];
    expect(summary).toMatchObject({ role: 'user' });
    if (summary.role === 'user') {
      expect(summary.content[0].text).toContain('CONVERSATION SUMMARY');
    }

    expect(agent.log.events.some((e) => e.type === 'history/compact')).toBe(true);
    expect(agent.log.deriveMessages()).toHaveLength(10);

    expect(agent.projection.messages.at(-1)?.role).toBe('assistant');
  });
});

describe('tokens', () => {
  it('counts CJK characters as heavier than latin', () => {
    expect(estimateTokens('中文')).toBe(2);
    expect(estimateTokens('ab')).toBe(1);
    expect(estimateTokens('中文')).toBeGreaterThan(estimateTokens('ab'));
  });

  it('adds per-message overhead in estimateMessages', () => {
    const total = estimateMessages([userMessage('hi'), assistantMessage('hello')]);
    expect(total).toBeGreaterThan(estimateTokens('hihello'));
  });
});

describe('Compactor', () => {
  const model = { provider: 'fake', id: 'fake-1', contextWindow: 400, maxTokens: 256 };

  it('triggers only above the budget and beyond keepRecent', () => {
    const c = new Compactor({ triggerTokens: 50, keepRecent: 2 });

    const short = [userMessage('a'), assistantMessage('b')];
    expect(c.needsCompaction(short, model)).toBe(false);

    const long = Array.from({ length: 5 }, () => userMessage('x'.repeat(100)));
    expect(c.needsCompaction(long, model)).toBe(true);

    const underBudget = new Compactor({ triggerTokens: 1_000_000, keepRecent: 2 });
    expect(underBudget.needsCompaction([userMessage('a'), assistantMessage('b'), userMessage('c')], model)).toBe(false);
  });

  it('folds the head into a cached summary', async () => {
    let summarizeCalls = 0;
    const adapter: LlmAdapter = async function* () {
      summarizeCalls += 1;
      yield { type: 'text_delta', delta: 'SUMMARY' };
      yield { type: 'done', stopReason: 'stop' };
    };

    const c = new Compactor({ keepRecent: 2 });
    const msgs = [
      userMessage('one'),
      assistantMessage('two'),
      userMessage('three'),
      assistantMessage('four'),
      userMessage('five'),
    ];
    const signal = new AbortController().signal;

    const first = await c.compile(msgs, adapter, model, signal);
    expect(first.compacted).toBe(true);
    expect(first.messages).toHaveLength(3);
    expect(first.messages[0]).toMatchObject({ role: 'user' });
    expect(summarizeCalls).toBe(1);

    const grown = [...msgs, assistantMessage('six')];
    await c.compile(grown, adapter, model, signal);
    expect(summarizeCalls).toBe(2);

    await c.compile(grown, adapter, model, signal);
    expect(summarizeCalls).toBe(2);
  });
});