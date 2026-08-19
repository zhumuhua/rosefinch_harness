/**
 * Script-driven fake LLM adapter. Each request consumes the next queued reply,
 * which can be a text response or a list of tool calls. Makes the full loop
 * deterministic and keyless, and doubles as the test double.
 */

import { ZERO_USAGE } from '../types.ts';
import type { LlmAdapter, LlmContext, LlmOptions, LlmStream, Model, StreamEvent } from './types.ts';

export interface FakeReply {
  /** Optional initial text before any tool calls. */
  text?: string;
  /** Tool calls to emit (in order). Defaults to none. */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** Terminates the stream with an error instead of `done`. */
  error?: string;
}

export interface FakeModelOptions {
  /** Replies consumed one per request; the last one is reused if exhausted. */
  replies: FakeReply[];
}

async function* scripted(reply: FakeReply): AsyncIterable<StreamEvent> {
  if (reply.error) {
    yield { type: 'error', message: reply.error };
    return;
  }
  if (reply.text) {
    yield { type: 'text_delta', delta: reply.text };
  }
  for (const call of reply.toolCalls ?? []) {
    yield { type: 'tool_call', ...call };
  }
  const stopReason = reply.toolCalls && reply.toolCalls.length > 0 ? 'toolUse' : 'stop';
  yield { type: 'done', stopReason, usage: { ...ZERO_USAGE, output: 1, total: 1 } };
}

export function fakeAdapter(options: FakeModelOptions): LlmAdapter {
  let index = 0;
  return function createFakeStream(
    _model: Model,
    _context: LlmContext,
    _options: LlmOptions,
  ): LlmStream {
    const reply = options.replies[Math.min(index, options.replies.length - 1)];
    if (index < options.replies.length) index += 1;
    if (!reply) throw new Error('fake adapter has no replies');
    return scripted(reply);
  };
}

/** Convenience: one-shot adapter for a single reply. */
export function oneShot(reply: FakeReply): LlmAdapter {
  return fakeAdapter({ replies: [reply] });
}