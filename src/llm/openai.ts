/**
 * OpenAI-compatible streaming adapter (zero runtime deps, native `fetch`).
 *
 * Targets the de-facto `/chat/completions` SSE protocol, so the same adapter
 * drives OpenAI, DeepSeek, and most self-hosted gateways by pointing `baseUrl`
 * at their endpoint. It maps our {@link StreamEvent} language onto OpenAI's
 * chunked deltas, assembling streamed tool-call fragments into complete calls.
 */

import type { Usage } from '../types.ts';
import type {
  LlmAdapter,
  LlmContext,
  LlmOptions,
  LlmStream,
  Model,
  ModelTool,
  StreamEvent,
} from './types.ts';

export interface OpenAiAdapterConfig {
  /** Defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /** Defaults to `https://api.openai.com/v1`. */
  baseUrl?: string;
  /** Override the model id sent in the request. Defaults to `model.id`. */
  model?: string;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Message / tool conversion (our vocabulary -> OpenAI wire format)
// ---------------------------------------------------------------------------

function toOpenAiMessage(message: import('../types.ts').Message): Record<string, unknown> {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content.map((b) => b.text).join('\n') };
    case 'toolResult':
      return {
        role: 'tool',
        content: message.content.map((b) => b.text).join('\n'),
        tool_call_id: message.toolCallId,
      };
    case 'assistant': {
      let text = '';
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
      for (const block of message.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'toolCall') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: block.arguments },
          });
        }
      }
      return {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
    }
  }
}

function toOpenAiTool(tool: ModelTool): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

/** Map OpenAI usage field names into our {@link Usage}. */
function toUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const prompt = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : u.input;
  const completion = typeof u.completion_tokens === 'number' ? u.completion_tokens : u.output;
  const total = typeof u.total_tokens === 'number' ? u.total_tokens : u.total;
  const input = typeof prompt === 'number' ? prompt : 0;
  const output = typeof completion === 'number' ? completion : 0;
  if (input === 0 && output === 0 && typeof total !== 'number') return undefined;
  return {
    input,
    output,
    total: typeof total === 'number' ? total : input + output,
  };
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

interface AssembledToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Parse one SSE block, mutating `toolCalls` and returning emitted events. */
function parseOpenAiChunk(
  raw: string,
  toolCalls: Map<number, AssembledToolCall>,
): { events: StreamEvent[]; done: boolean } {
  const events: StreamEvent[] = [];
  let done = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') continue;

    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    const choice = json.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      events.push({ type: 'text_delta', delta: delta.content });
    }
    for (const tc of (delta.tool_calls ?? []) as Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>) {
      const index = tc.index ?? 0;
      const assembled = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) assembled.id = tc.id;
      if (tc.function?.name) assembled.name = tc.function.name;
      if (tc.function?.arguments) assembled.arguments += tc.function.arguments;
      toolCalls.set(index, assembled);
    }

    if (choice.finish_reason) {
      done = true;
      const usage = toUsage(json.usage ?? choice.usage);
      const finish: string = choice.finish_reason;
      if (finish === 'tool_calls') {
        for (const call of toolCalls.values()) {
          if (call.name) {
            events.push({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments });
          }
        }
        events.push({ type: 'done', stopReason: 'toolUse', usage });
      } else if (finish === 'length') {
        events.push({ type: 'done', stopReason: 'length', usage });
      } else {
        events.push({ type: 'done', stopReason: 'stop', usage });
      }
    }
  }
  return { events, done };
}

async function* parseOpenAiStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, AssembledToolCall>();
  let buffer = '';
  let sawDone = false;

  for await (const chunk of body) {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseOpenAiChunk(raw, toolCalls);
      sawDone ||= parsed.done;
      for (const event of parsed.events) yield event;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseOpenAiChunk(buffer, toolCalls);
    sawDone ||= parsed.done;
    for (const event of parsed.events) yield event;
  }

  // A truncated stream without a finish_reason: flush assembled tool calls and
  // synthesize a clean stop so the caller still receives exactly one `done`.
  if (!sawDone) {
    for (const call of toolCalls.values()) {
      if (call.name) {
        yield { type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments };
      }
    }
    yield { type: 'done', stopReason: 'stop' };
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function openAiAdapter(config: OpenAiAdapterConfig = {}): LlmAdapter {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  const baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');

  return async function* stream(
    model: Model,
    context: LlmContext,
    options: LlmOptions,
  ): LlmStream {
    if (!apiKey) {
      yield { type: 'error', message: 'OPENAI_API_KEY is not set' };
      return;
    }

    const body = {
      model: config.model ?? model.id,
      messages: context.messages.map(toOpenAiMessage),
      ...(context.tools.length > 0 ? { tools: context.tools.map(toOpenAiTool) } : {}),
      stream: true,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    };

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...config.headers,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (error) {
      // Let aborts propagate to the driver's abort path; surface the rest as an event.
      if (options.signal?.aborted) throw error;
      yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
      return;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      yield { type: 'error', message: `OpenAI ${response.status}: ${detail.slice(0, 500)}` };
      return;
    }

    yield* parseOpenAiStream(response.body as ReadableStream<Uint8Array>, options.signal);
  };
}