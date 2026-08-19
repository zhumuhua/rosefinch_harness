/**
 * The thin driver: an explicit `Phase` state machine with `turn`/`step`
 * boundaries, plus waterfall decision points (`pre-step`, `request`,
 * `request-error`). Zero hardcoded tunables — everything redirects through
 * config or the dispatch, so new behavior attaches to extension points instead
 * of patching this loop.
 *
 * Turn flow (DeepSeek-Harness-shaped):
 *
 *   turn/start
 *     claim next-turn/next-step input -> pre-step (enter | reject)
 *     step/start
 *       user/message* -> request/header -> adapter stream -> assistant/message
 *       tool/call* -> tool/result*   (via the scheduler)
 *     step/end
 *   turn/end
 */

import { ZERO_USAGE, toolCallsOf, type AssistantMessage, type Message, type StopReason, type TurnEndReason, type UserMessage } from './types.ts';
import type { EventLog } from './event-log.ts';
import type { Dispatch, RequestConfig } from './dispatch.ts';
import type { Inbox } from './inbox.ts';
import type { ToolRegistry } from './tools/registry.ts';
import type { AgentHandle } from './tools/types.ts';
import { executeToolCalls } from './scheduler.ts';
import type { Compactor } from './compactor.ts';
import type { LlmAdapter, Model, StreamEvent } from './llm/types.ts';

export interface DriverDeps {
  log: EventLog;
  dispatch: Dispatch;
  inbox: Inbox;
  registry: ToolRegistry;
  adapter: LlmAdapter;
  model: Model;
  system: string;
  maxParallelToolCalls: number;
  handle: AgentHandle;
  /** When set, the driver compacts overflowing history via the maintenance phase. */
  compactor?: Compactor;
}

export type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'running'; abort: AbortController; turn: number; step: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number };

class LlmError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class Driver {
  private phase: Phase = { kind: 'idle', lastTurn: 0 };
  private activityDone: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DriverDeps) {}

  get status(): Phase['kind'] {
    return this.phase.kind;
  }

  get lastTurn(): number {
    return this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn;
  }

  whenIdle(): Promise<void> {
    return this.activityDone;
  }

  // -- input entry points ------------------------------------------------

  /** Queue a prompt as a next-turn message and wake the driver. */
  start(message: UserMessage): Promise<void> {
    this.deps.inbox.followUp(message);
    return this.wake();
  }

  steer(message: UserMessage): void {
    this.deps.inbox.steer(message);
    void this.wake();
  }

  followUp(message: UserMessage): void {
    this.deps.inbox.followUp(message);
    void this.wake();
  }

  inject(message: UserMessage): void {
    this.deps.inbox.inject(message);
  }

  cancel(reason?: string): void {
    if (this.phase.kind !== 'idle') {
      this.phase.abort.abort(reason ? new Error(reason) : undefined);
    }
  }

  // -- driver ------------------------------------------------------------

  private wake(): Promise<void> {
    if (this.phase.kind !== 'idle') return this.activityDone;
    const done = deferred();
    this.activityDone = done.promise;
    const abort = new AbortController();
    this.phase = { kind: 'running', abort, turn: this.phase.lastTurn, step: 0 };
    this.kick(abort.signal).then(done.resolve, done.reject);
    return done.promise;
  }

  private async kick(signal: AbortSignal): Promise<void> {
    try {
      await this.deps.dispatch.emit('agent/start', { agentId: this.deps.handle.id });
      while (this.deps.inbox.hasPending && !signal.aborted) {
        const cont = await this.turn();
        if (!cont) break;
      }
      await this.deps.dispatch.emit('agent/end', { agentId: this.deps.handle.id });
    } finally {
      const running = this.phase;
      this.phase = {
        kind: 'idle',
        lastTurn: running.kind === 'running' ? running.turn : running.lastTurn,
      };
    }
  }

  private async turn(): Promise<boolean> {
    const phase = this.phase;
    if (phase.kind !== 'running') throw new Error('turn() outside running phase');
    const { signal } = phase.abort;
    const turn = phase.turn + 1;
    phase.turn = turn;
    phase.step = 0;

    this.deps.log.append({ type: 'turn/start', turn });
    await this.deps.dispatch.emit('turn/start', { turn });

    let reason: TurnEndReason = { kind: 'completed' };
    let target: 'next-turn' | 'next-step' = 'next-turn';
    // When true, the next step feeds the just-settled tool results back to the
    // model (the ReAct loop's automatic continuation) rather than waiting for a
    // fresh inbox message.
    let continueForTools = false;

    try {
      while (true) {
        signal.throwIfAborted();
        const step = phase.step + 1;

        const claimed = target === 'next-turn' ? this.deps.inbox.claimTurn() : this.deps.inbox.claimStep();
        const decision = await this.deps.dispatch.runPreStep(
          { turn, step, messages: claimed, signal },
          { kind: 'enter', messages: claimed },
        );

        if (decision.kind === 'reject') {
          reason = { kind: 'blocked' };
          break;
        }
        if (decision.messages.length === 0 && !continueForTools) {
          reason = { kind: 'completed' };
          break;
        }
        continueForTools = false;

        phase.step = step;
        this.deps.log.append({ type: 'step/start', turn, step });
        try {
          for (const message of decision.messages) {
            this.deps.log.append({ type: 'user/message', turn, step, message });
          }

          let messages = this.deps.log.deriveMessages();
          messages = await this.compactIfNeeded(messages, turn, step, signal);

          const config = await this.deps.dispatch.runRequest(
            { turn, step, signal },
            {
              provider: this.deps.model.provider,
              model: this.deps.model.id,
              system: this.deps.system,
              tools: this.deps.registry.toModelTools(),
            },
          );

          this.deps.log.append({
            type: 'request/header',
            turn,
            step,
            provider: config.provider,
            model: config.model,
            system: config.system,
            toolNames: config.tools.map((t) => t.name),
          });

          const assistant = await this.callLlm(config, messages, turn, step, signal);
          this.deps.log.append({ type: 'assistant/message', turn, step, message: assistant });

          const toolCalls = toolCallsOf(assistant);
          let concluded = true;
          if (toolCalls.length > 0) {
            const outcome = await executeToolCalls({
              log: this.deps.log,
              registry: this.deps.registry,
              agent: this.deps.handle,
              turn,
              step,
              toolCalls,
              signal,
              maxParallelToolCalls: this.deps.maxParallelToolCalls,
              acceptContext: (message) => this.deps.inbox.inject(message),
            });
            concluded = outcome.concluded;
            if (!concluded) continueForTools = true;
          }

          if (assistant.stopReason === 'length') {
            reason = { kind: 'max-tokens' };
            break;
          }
          if (concluded) {
            reason = { kind: 'completed' };
            break;
          }
          target = 'next-step';
        } finally {
          this.deps.log.append({ type: 'step/end', turn, step });
        }
      }
    } catch (error) {
      if (signal.aborted) {
        reason = { kind: 'aborted', reason: String(signal.reason) };
      } else if (error instanceof LlmError) {
        reason = { kind: 'error', code: error.code, message: error.message };
      } else {
        reason = { kind: 'error', code: 'UNKNOWN', message: String(error) };
      }
    } finally {
      this.deps.log.append({ type: 'turn/end', turn, reason });
      await this.deps.dispatch.emit('turn/end', { turn, reason });
    }

    return this.deps.inbox.hasPending;
  }

  // -- context compaction (maintenance phase) ------------------------------

  private async compactIfNeeded(
    messages: Message[],
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<Message[]> {
    const compactor = this.deps.compactor;
    if (!compactor || !compactor.needsCompaction(messages, this.deps.model)) {
      return messages;
    }

    const running = this.phase;
    if (running.kind !== 'running') return messages;

    // Suspend normal turns and surface the state so queued work sees it.
    this.phase = { kind: 'maintenance', abort: running.abort, lastTurn: running.turn };
    try {
      const compiled = await compactor.compile(messages, this.deps.adapter, this.deps.model, signal);
      this.deps.log.append({
        type: 'history/compact',
        turn,
        step,
        summary: compiled.summaryText,
        summarizedCount: compiled.summarizedCount,
      });
      return compiled.messages;
    } finally {
      this.phase = running;
    }
  }

  // -- LLM call with request-error retry ----------------------------------

  private async callLlm(
    config: RequestConfig,
    messages: Message[],
    turn: number,
    step: number,
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    while (true) {
      try {
        const stream = this.deps.adapter(
          this.deps.model,
          { system: config.system, messages, tools: config.tools },
          { temperature: config.temperature, maxTokens: config.maxTokens, signal },
        );

        let text = '';
        const toolCalls: { id: string; name: string; arguments: string }[] = [];
        let stopReason: StopReason = 'stop';
        let usage = ZERO_USAGE;

        for await (const event of stream as AsyncIterable<StreamEvent>) {
          signal.throwIfAborted();
          switch (event.type) {
            case 'text_delta':
              text += event.delta;
              // Fire-and-forget so a slow subscriber never backpressures the
              // model stream; deltas still land in order for sync handlers.
              void this.deps.dispatch.emit('text/delta', { turn, step, delta: event.delta });
              break;
            case 'tool_call':
              toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
              break;
            case 'done':
              stopReason = event.stopReason;
              usage = event.usage ?? ZERO_USAGE;
              break;
            case 'error':
              throw new LlmError('PROVIDER_ERROR', event.message);
          }
        }

        return {
          role: 'assistant',
          content: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...toolCalls.map((c) => ({ type: 'toolCall' as const, ...c })),
          ],
          provider: config.provider,
          model: config.model,
          stopReason,
          usage,
          timestamp: Date.now(),
        };
      } catch (error) {
        if (signal.aborted) throw error;
        const retry = await this.deps.dispatch.runRequestError({
          turn,
          step,
          signal,
          failure: {
            message: error instanceof Error ? error.message : String(error),
            code: error instanceof LlmError ? error.code : 'UNKNOWN',
          },
        });
        if (retry) continue;
        throw error;
      }
    }
  }
}