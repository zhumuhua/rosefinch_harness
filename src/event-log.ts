/**
 * Append-only session event log — the single source of truth.
 *
 * Every fact (turn boundaries, messages, tool calls/results, request headers)
 * is appended here with a monotonic `seq`. Nothing is ever mutated or deleted.
 * {@link deriveMessages} reconstructs the model-visible history from scratch;
 * that is the reference implementation the projection is validated against.
 */

import type { Message, SessionEvent } from './types.ts';

export interface LoggedEvent<E extends SessionEvent = SessionEvent> {
  seq: number;
  event: E;
}

/** Called synchronously after an event is committed, in log order. */
export type LogSubscriber = (logged: LoggedEvent) => void;

export class EventLog {
  private readonly _events: SessionEvent[] = [];
  private _seq = 0;
  private readonly _subscribers = new Set<LogSubscriber>();

  /** Append one event and notify subscribers. Returns the sequenced wrapper. */
  append<E extends SessionEvent>(event: E): LoggedEvent<E> {
    const seq = ++this._seq;
    this._events.push(event);
    const logged: LoggedEvent = { seq, event };
    for (const subscriber of this._subscribers) {
      subscriber(logged);
    }
    return logged as LoggedEvent<E>;
  }

  subscribe(subscriber: LogSubscriber): () => void {
    this._subscribers.add(subscriber);
    // Replay already-logged events so a late subscriber reaches the same state.
    for (const event of this._events) {
      subscriber({ seq: this._events.indexOf(event) + 1, event });
    }
    return () => this._subscribers.delete(subscriber);
  }

  get events(): readonly SessionEvent[] {
    return this._events;
  }

  get length(): number {
    return this._events.length;
  }

  get seq(): number {
    return this._seq;
  }

  findLast(predicate: (event: SessionEvent) => boolean): SessionEvent | undefined {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const event = this._events[i];
      if (event && predicate(event)) return event;
    }
    return undefined;
  }

  /**
   * Reconstruct the model-visible history from the log. This is the ground
   * truth; the projection must agree with it. Only durable message events
   * contribute — turn/step/request boundaries do not.
   */
  deriveMessages(): Message[] {
    const messages: Message[] = [];
    for (const event of this._events) {
      switch (event.type) {
        case 'user/message':
          messages.push(event.message);
          break;
        case 'assistant/message':
          messages.push(event.message);
          break;
        case 'tool/result':
          messages.push(event.message);
          break;
        default:
          break;
      }
    }
    return messages;
  }
}