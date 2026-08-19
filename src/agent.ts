/**
 * The public agent facade: wires the log (source of truth), its projection,
 * the tool registry, the driver, and the extension dispatch into one object.
 *
 * It is *thin* — the driver owns concurrency and control flow; the agent only
 * composes dependencies and exposes ergonomic entry points. It also serves as
 * the {@link AgentHandle} handed to tools, so tools can inject model-visible
 * context without reaching for the log directly.
 */

import { randomUUID } from 'node:crypto';

import type { UserMessage } from './types.ts';
import { EventLog } from './event-log.ts';
import { Projection } from './projection.ts';
import { Dispatch } from './dispatch.ts';
import { Inbox } from './inbox.ts';
import { ToolRegistry } from './tools/registry.ts';
import type { LlmAdapter, Model } from './llm/types.ts';
import { Compactor, type CompactionOptions } from './compactor.ts';
import { Driver, type Phase } from './loop.ts';

export interface AgentOptions {
  /** The model the agent targets. */
  model: Model;
  /** System prompt. Empty by default. */
  system?: string;
  /** LLM adapter; defaults to a fake that always returns "done". */
  adapter?: LlmAdapter;
  /** Bounded pool size for parallel tool calls. Defaults to 4. */
  maxParallelToolCalls?: number;
  /** Stable id; a random UUID when omitted. */
  id?: string;
  /**
   * Enable context compaction: `true` for defaults, an object to tune the
   * token budget / keep-recent window / summary prompt, `false` or omitted to
   * disable. When enabled, overflowing history is summarized via the
   * maintenance phase before the outgoing request.
   */
  compaction?: boolean | CompactionOptions;
}

function emptyAdapter(): LlmAdapter {
  return async function* () {
    yield { type: 'done', stopReason: 'stop' };
  };
}

export function toUserMessage(text: string): UserMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() };
}

export class Agent {
  readonly id: string;
  readonly log = new EventLog();
  readonly projection = new Projection();
  readonly dispatch = new Dispatch();
  readonly inbox = new Inbox();
  readonly tools = new ToolRegistry();

  private readonly driver: Driver;
  private readonly detachProjection: () => void;

  constructor(options: AgentOptions) {
    this.id = options.id ?? randomUUID();

    const adapter = options.adapter ?? emptyAdapter();
    const model = options.model;
    const system = options.system ?? '';
    const maxParallelToolCalls = options.maxParallelToolCalls ?? 4;
    const compaction = options.compaction;
    const compactor = compaction
      ? new Compactor(compaction === true ? {} : compaction)
      : undefined;

    this.detachProjection = this.projection.attach(this.log);
    this.driver = new Driver({
      log: this.log,
      dispatch: this.dispatch,
      inbox: this.inbox,
      registry: this.tools,
      adapter,
      model,
      system,
      maxParallelToolCalls,
      handle: this,
      compactor,
    });
  }

  get status(): Phase['kind'] {
    return this.driver.status;
  }

  get lastTurn(): number {
    return this.driver.lastTurn;
  }

  /** Queue a prompt as a next-turn message and wait for the driver to go idle. */
  prompt(text: string): Promise<void> {
    return this.driver.start(toUserMessage(text));
  }

  /** Interrupt the current step with a steering message (next-step). */
  steer(text: string): void {
    this.driver.steer(toUserMessage(text));
  }

  /** Schedule a message to run after the agent would otherwise stop. */
  followUp(text: string): void {
    this.driver.followUp(toUserMessage(text));
  }

  /** Satisfies {@link import('./tools/types.ts').AgentHandle}. */
  inject(message: UserMessage): void {
    this.driver.inject(message);
  }

  cancel(reason?: string): void {
    this.driver.cancel(reason);
  }

  whenIdle(): Promise<void> {
    return this.driver.whenIdle();
  }
}