/**
 * Core vocabulary: messages, tool calls, and the session event log.
 *
 * The session event log is the *single source of truth*. Messages are derived
 * views of it (see {@link EventLog.deriveMessages} in event-log.ts). The rule:
 * **model-visible ⟺ logged** — anything the model sees must be reconstructable
 * from the log.
 */

// ---------------------------------------------------------------------------
// Message content blocks (Pi-style: union of typed blocks)
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface ToolCallBlock {
  type: 'toolCall';
  id: string;
  name: string;
  /** Raw JSON string as emitted by the model, parsed (best-effort) at execution. */
  arguments: string;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

export interface Usage {
  input: number;
  output: number;
  total: number;
}

export const ZERO_USAGE: Usage = { input: 0, output: 0, total: 0 };

export type StopReason = 'stop' | 'toolUse' | 'length' | 'error' | 'aborted';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface UserMessage {
  role: 'user';
  content: TextBlock[];
  timestamp: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: ContentBlock[];
  provider: string;
  model: string;
  stopReason: StopReason;
  usage?: Usage;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: TextBlock[];
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** A normalized tool call extracted from an assistant message. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string. */
  arguments: string;
}

export function toolCallsOf(message: AssistantMessage): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const block of message.content) {
    if (block.type === 'toolCall') {
      calls.push({ id: block.id, name: block.name, arguments: block.arguments });
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Session events
//
// The event map is an interface so third parties may extend it via TypeScript
// declaration merging:
//
//   declare module './types.ts' {
//     interface SessionEventMap {
//       'custom/thing': { turn: number };
//     }
//   }
//
// A `SessionEventMap` member is a tagged union via the mapped type below.
// ---------------------------------------------------------------------------

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'max-tokens' }
  | { kind: 'blocked' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'aborted'; reason?: string };

export interface SessionEventMap {
  'turn/start': { turn: number };
  'turn/end': { turn: number; reason: TurnEndReason };
  'step/start': { turn: number; step: number };
  'step/end': { turn: number; step: number };
  'user/message': { turn: number; step: number; message: UserMessage };
  'assistant/message': { turn: number; step: number; message: AssistantMessage };
  'tool/call': { turn: number; step: number; callId: string; name: string; arguments: string };
  'tool/result': { turn: number; step: number; message: ToolResultMessage; callSeq: number };
  'request/header': {
    turn: number;
    step: number;
    provider: string;
    model: string;
    system: string;
    toolNames: string[];
  };
  'history/compact': { turn: number; step: number; summary: string; summarizedCount: number };
}

export type SessionEventType = keyof SessionEventMap;

export type SessionEvent = {
  [K in SessionEventType]: { type: K } & SessionEventMap[K];
}[SessionEventType];

/** Extract the payload of a specific event type. */
export type SessionEventOf<K extends SessionEventType> = { type: K } & SessionEventMap[K];