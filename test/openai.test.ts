import { afterEach, describe, expect, it, vi } from 'vitest';

import { openAiAdapter } from '../src/llm/openai.ts';
import type { LlmContext, Model, StreamEvent } from '../src/llm/types.ts';

const model: Model = { provider: 'openai', id: 'gpt-test', contextWindow: 8000, maxTokens: 100 };

function sse(...objects: unknown[]): string {
  return objects.map((o) => `data: ${JSON.stringify(o)}`).join('\n\n') + '\n\n';
}

function sseResponse(data: string, status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
  return new Response(body, { status });
}

function context(messages: LlmContext['messages'] = []): LlmContext {
  return { system: 'sys', messages, tools: [] };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openAiAdapter', () => {
  it('streams text deltas and terminates with a stop done', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        sse(
          { choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = openAiAdapter({ apiKey: 'sk-test' });
    const ctx = context([{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }]);
    const events = await collect(adapter(model, ctx, {}));

    const deltas = events.filter((e) => e.type === 'text_delta');
    expect(deltas).toEqual([
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ' world' },
    ]);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ stopReason: 'stop' });
  });

  it('assembles streamed tool-call fragments into one complete call', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse(
        sse(
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, finish_reason: null },
            ],
          },
          {
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"Beijing"}' } }] }, finish_reason: null },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = openAiAdapter({ apiKey: 'sk-test' });
    const events = await collect(adapter(model, context(), {}));

    expect(events.find((e) => e.type === 'tool_call')).toEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Beijing"}',
    });
    expect(events.find((e) => e.type === 'done')).toMatchObject({ stopReason: 'toolUse' });
  });

  it('surfaces a non-200 response as an error event', async () => {
    const fetchMock = vi.fn(async () => sseResponse('', 401));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = openAiAdapter({ apiKey: 'sk-test' });
    const ctx = context([{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 }]);
    const events = await collect(adapter(model, ctx, {}));

    expect(events).toEqual([{ type: 'error', message: expect.stringContaining('401') }]);
  });

  it('sends converted messages, tools, and options in the request body', async () => {
    const fetchMock = vi.fn(async () => sseResponse(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = openAiAdapter({ apiKey: 'sk-test', baseUrl: 'https://example.test/v1' });
    const ctx: LlmContext = {
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'toolCall', id: 'c1', name: 'w', arguments: '{}' },
          ],
          provider: 'openai',
          model: 'gpt-test',
          stopReason: 'toolUse',
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'w',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 2,
        },
      ],
      tools: [{ name: 'w', description: 'd', parameters: { type: 'object', properties: {} } }],
    };

    await collect(adapter(model, ctx, { temperature: 0.5, maxTokens: 50 }));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/chat/completions');

    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-test');
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(50);
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'hello',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: '{}' } }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    ]);
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'w', description: 'd', parameters: { type: 'object', properties: {} } } },
    ]);
  });
});