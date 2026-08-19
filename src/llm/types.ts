/**
 * Unified LLM stream abstraction (Pi-style): a single `stream` shape over any
 * backend. Providers are adapters that yield a stream of {@link StreamEvent}.
 * The fake adapter in fake.ts implements this with a scripted response, so the
 * whole pipeline runs with no API key.
 */

import type { StopReason, Usage } from '../types.ts';

export interface Model {
  provider: string;
  id: string;
  contextWindow: number;
  maxTokens: number;
}

/** The model-facing tool description, decoupled from execution. */
export interface ModelTool {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: unknown;
}

export interface LlmContext {
  system: string;
  messages: import('../types.ts').Message[];
  tools: ModelTool[];
}

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text_delta'; delta: string }
  /** Complete tool call (simplified: no incremental argument streaming). */
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'done'; stopReason: StopReason; usage?: Usage }
  | { type: 'error'; message: string };

export type LlmStream = AsyncIterable<StreamEvent>;

export type LlmAdapter = (model: Model, context: LlmContext, options: LlmOptions) => LlmStream;