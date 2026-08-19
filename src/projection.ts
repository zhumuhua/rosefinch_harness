/**
 * Incremental in-memory projection of the event log.
 *
 * The projection is a *derived* convenience view (a Pi-style AgentState) that a
 * UI or consumer reads. It is updated synchronously from the log and never
 * writes back: the log stays authoritative.
 */

import type { EventLog, LoggedEvent } from './event-log.ts';
import { ZERO_USAGE, type Message, type Usage } from './types.ts';

function addUsage(acc: Usage, usage: Usage | undefined): Usage {
  if (!usage) return acc;
  return {
    input: acc.input + usage.input,
    output: acc.output + usage.output,
    total: acc.total + usage.total,
  };
}

export class Projection {
  messages: Message[] = [];
  usage: Usage = ZERO_USAGE;
  currentTurn = 0;
  currentStep = 0;

  /** Attach to a log; existing events are replayed so state is reconstructed. */
  attach(log: EventLog): () => void {
    return log.subscribe((logged) => this.apply(logged));
  }

  private apply(logged: LoggedEvent): void {
    const event = logged.event;
    switch (event.type) {
      case 'user/message':
        this.messages.push(event.message);
        break;
      case 'assistant/message':
        this.messages.push(event.message);
        this.usage = addUsage(this.usage, event.message.usage);
        break;
      case 'tool/result':
        this.messages.push(event.message);
        break;
      case 'turn/start':
        this.currentTurn = event.turn;
        break;
      case 'step/start':
        this.currentStep = event.step;
        break;
      default:
        break;
    }
  }

  /** Convenience: the last message in the projected history, if any. */
  get lastMessage(): Message | undefined {
    return this.messages[this.messages.length - 1];
  }
}