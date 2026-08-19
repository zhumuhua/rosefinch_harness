/**
 * Message inbox with three delivery semantics (Pi's steering/follow-up plus
 * DeepSeek Harness's inject):
 *
 * - `steer`   — next-step (interrupt current work) and wake the driver.
 * - `followUp` — next-turn (run after the agent would otherwise stop) and wake.
 * - `inject`  — next-step but *no wake*: waits until another message wakes the driver.
 */

import type { UserMessage } from './types.ts';

export class Inbox {
  private _nextStep: UserMessage[] = [];
  private _nextTurn: UserMessage[] = [];
  private _wakeRequested = false;

  steer(message: UserMessage): void {
    this._nextStep.push(message);
    this._wakeRequested = true;
  }

  inject(message: UserMessage): void {
    this._nextStep.push(message);
  }

  followUp(message: UserMessage): void {
    this._nextTurn.push(message);
    this._wakeRequested = true;
  }

  get hasPending(): boolean {
    return this._nextStep.length > 0 || this._nextTurn.length > 0;
  }

  get nextStepCount(): number {
    return this._nextStep.length;
  }

  get wakeRequested(): boolean {
    return this._wakeRequested;
  }

  clearWake(): void {
    this._wakeRequested = false;
  }

  /** Drain the next-step queue. */
  claimStep(): UserMessage[] {
    const drained = this._nextStep;
    this._nextStep = [];
    return drained;
  }

  /** Drain the next-turn queue. */
  claimTurn(): UserMessage[] {
    const drained = this._nextTurn;
    this._nextTurn = [];
    return drained;
  }

  clear(): void {
    this._nextStep = [];
    this._nextTurn = [];
    this._wakeRequested = false;
  }
}