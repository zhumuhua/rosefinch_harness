/**
 * Context compaction (DeepSeek-Harness's recompact, trimmed to a skeleton).
 *
 * The log stays append-only and never loses a message. Compaction is a
 * *derived, model-facing view*: when the estimated history exceeds the token
 * budget, the oldest messages are summarized by the same LLM adapter into a
 * single preamble message, and only the most recent `keepRecent` messages are
 * sent through verbatim. The summarization result is cached against the number
 * of messages folded in, so steady-state steps do not re-summarize.
 *
 * The driver records the fact of compaction (and the summary text) as a
 * `history/compact` log event, so the outgoing view remains auditable.
 */

import type { Message, UserMessage } from './types.ts';
import type { LlmAdapter, Model } from './llm/types.ts';
import { estimateMessages } from './tokens.ts';

export interface CompactionOptions {
  /** Estimated-token budget above which compaction triggers. Default 0.8 × contextWindow. */
  triggerTokens?: number;
  /** Number of most-recent messages always kept verbatim. Default 4. */
  keepRecent?: number;
  /** System prompt for the summarization call. */
  summaryPrompt?: string;
  /** Token cap for the summarization call. Default 1024. */
  maxSummaryTokens?: number;
}

export interface CompiledHistory {
  /** The model-facing message list (possibly [summary, ...recent]). */
  messages: Message[];
  /** True when compaction was applied to this history. */
  compacted: boolean;
  /** Number of messages folded into the summary. */
  summarizedCount: number;
  summaryText: string;
}

const DEFAULT_SUMMARY_PROMPT =
  'Summarize the conversation, preserving specific facts, decisions, user ' +
  'preferences, and pending tasks. Output only the summary with no preamble.';

export class Compactor {
  private summaryText = '';
  private summarizedCount = 0;

  constructor(private readonly options: CompactionOptions = {}) {}

  needsCompaction(messages: Message[], model: Model): boolean {
    const keep = this.options.keepRecent ?? 4;
    if (messages.length <= keep) return false;
    const budget = this.options.triggerTokens ?? Math.floor(model.contextWindow * 0.8);
    return estimateMessages(messages) > budget;
  }

  async compile(
    messages: Message[],
    adapter: LlmAdapter,
    model: Model,
    signal: AbortSignal,
  ): Promise<CompiledHistory> {
    const keep = this.options.keepRecent ?? 4;
    if (messages.length <= keep) {
      return { messages, compacted: false, summarizedCount: 0, summaryText: '' };
    }

    const headCount = messages.length - keep;
    if (this.summaryText === '' || headCount > this.summarizedCount) {
      this.summaryText = await this.summarize(messages.slice(0, headCount), adapter, model, signal);
      this.summarizedCount = headCount;
    }

    const summaryMessage: UserMessage = {
      role: 'user',
      content: [{ type: 'text', text: this.summaryText }],
      timestamp: Date.now(),
    };
    return {
      messages: [summaryMessage, ...messages.slice(-keep)],
      compacted: true,
      summarizedCount: this.summarizedCount,
      summaryText: this.summaryText,
    };
  }

  private async summarize(
    messages: Message[],
    adapter: LlmAdapter,
    model: Model,
    signal: AbortSignal,
  ): Promise<string> {
    const stream = adapter(
      model,
      { system: this.options.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT, messages, tools: [] },
      { signal, maxTokens: this.options.maxSummaryTokens ?? 1024 },
    );
    let text = '';
    for await (const event of stream) {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      if (event.type === 'text_delta') text += event.delta;
      else if (event.type === 'error') throw new Error(event.message);
    }
    return text.trim() || '[summary unavailable]';
  }
}