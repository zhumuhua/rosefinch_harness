/**
 * Token estimation heuristic. Not a tokenizer — a cheap, deterministic
 * approximation used to decide when to compact. CJK characters are counted as
 * roughly one token each; latin text as ~3.5 characters per token, plus a
 * fixed per-message overhead for role markers and tool scaffolding.
 */

import type { Message } from './types.ts';

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x2e80) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 3.5);
}

/** Per-message fixed cost: role marker, delimiters, tool id/name plumbing. */
const MESSAGE_OVERHEAD = 4;

export function estimateMessages(messages: Message[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += MESSAGE_OVERHEAD;
    switch (message.role) {
      case 'user':
        tokens += message.content.reduce((n, b) => n + estimateTokens(b.text), 0);
        break;
      case 'toolResult':
        tokens += estimateTokens(message.toolName);
        tokens += message.content.reduce((n, b) => n + estimateTokens(b.text), 0);
        break;
      case 'assistant':
        for (const block of message.content) {
          if (block.type === 'text') tokens += estimateTokens(block.text);
          else if (block.type === 'toolCall') tokens += estimateTokens(block.name) + estimateTokens(block.arguments);
          else tokens += estimateTokens(block.thinking);
        }
        break;
    }
  }
  return tokens;
}