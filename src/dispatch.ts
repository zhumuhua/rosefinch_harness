/**
 * Extension dispatch: three waterfall decision points plus lifecycle emits.
 *
 * Waterfalls are around-middleware: the seed flows through handlers in
 * registration order, each may replace it or pass it through. Emits are
 * observers with no return value. Every registration returns a disposer
 * (reversible effects — DeepSeek-Harness-style).
 */

import type { TurnEndReason, UserMessage } from './types.ts';
import type { ModelTool } from './llm/types.ts';

export type Disposer = () => void;

// ---------------------------------------------------------------------------
// Waterfall decision points
// ---------------------------------------------------------------------------

export interface PreStepContext {
  turn: number;
  step: number;
  /** Messages claimed for this step, before the decision. */
  messages: UserMessage[];
  signal: AbortSignal;
}

export type PreStepDecision =
  | { kind: 'enter'; messages: UserMessage[] }
  | { kind: 'reject'; reason: string };

export type PreStepHandler = (
  ctx: PreStepContext,
  decision: PreStepDecision,
) => PreStepDecision | void | Promise<PreStepDecision | void>;

export interface RequestContext {
  turn: number;
  step: number;
  signal: AbortSignal;
}

export interface RequestConfig {
  provider: string;
  model: string;
  system: string;
  tools: ModelTool[];
  maxTokens?: number;
  temperature?: number;
}

export type RequestHandler = (
  ctx: RequestContext,
  config: RequestConfig,
) => RequestConfig | void | Promise<RequestConfig | void>;

export interface RequestErrorContext {
  turn: number;
  step: number;
  failure: { message: string; code: string };
  signal: AbortSignal;
}

export type RequestErrorHandler = (
  ctx: RequestErrorContext,
) => { kind: 'retry' } | void | Promise<{ kind: 'retry' } | void>;

// ---------------------------------------------------------------------------
// Lifecycle emits
// ---------------------------------------------------------------------------

export interface EmitEventMap {
  'agent/start': { agentId: string };
  'agent/end': { agentId: string };
  'turn/start': { turn: number };
  'turn/end': { turn: number; reason: TurnEndReason };
  'text/delta': { turn: number; step: number; delta: string };
  'tool/execution-start': { callId: string; name: string; args: unknown };
  'tool/execution-end': { callId: string; name: string; isError: boolean };
}

export type EmitEventName = keyof EmitEventMap;

export type EmitHandler<K extends EmitEventName> = (e: EmitEventMap[K]) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export class Dispatch {
  private readonly preStep = new Set<PreStepHandler>();
  private readonly request = new Set<RequestHandler>();
  private readonly requestError = new Set<RequestErrorHandler>();
  private readonly emits = new Map<EmitEventName, Set<EmitHandler<EmitEventName>>>();

  onPreStep(handler: PreStepHandler): Disposer {
    this.preStep.add(handler);
    return () => this.preStep.delete(handler);
  }

  onRequest(handler: RequestHandler): Disposer {
    this.request.add(handler);
    return () => this.request.delete(handler);
  }

  onRequestError(handler: RequestErrorHandler): Disposer {
    this.requestError.add(handler);
    return () => this.requestError.delete(handler);
  }

  on<K extends EmitEventName>(event: K, handler: EmitHandler<K>): Disposer {
    let bucket = this.emits.get(event);
    if (!bucket) {
      bucket = new Set();
      this.emits.set(event, bucket);
    }
    bucket.add(handler as EmitHandler<EmitEventName>);
    return () => bucket!.delete(handler as EmitHandler<EmitEventName>);
  }

  // -- waterfall runners -----------------------------------------------

  async runPreStep(ctx: PreStepContext, seed: PreStepDecision): Promise<PreStepDecision> {
    let decision = seed;
    for (const handler of [...this.preStep]) {
      decision = (await handler(ctx, decision)) ?? decision;
    }
    return decision;
  }

  async runRequest(ctx: RequestContext, seed: RequestConfig): Promise<RequestConfig> {
    let config = seed;
    for (const handler of [...this.request]) {
      config = (await handler(ctx, config)) ?? config;
    }
    return config;
  }

  /** Returns true when any handler requests a retry, false otherwise. */
  async runRequestError(ctx: RequestErrorContext): Promise<boolean> {
    for (const handler of [...this.requestError]) {
      if ((await handler(ctx))?.kind === 'retry') return true;
    }
    return false;
  }

  // -- emit runner -----------------------------------------------------

  async emit<K extends EmitEventName>(event: K, payload: EmitEventMap[K]): Promise<void> {
    const bucket = this.emits.get(event);
    if (!bucket) return;
    for (const handler of [...bucket]) {
      await handler(payload as never);
    }
  }
}