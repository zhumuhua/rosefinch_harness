/**
 * Tool scheduler (DeepSeek-Harness-style): exclusive barriers for sequential
 * tools, a bounded rolling pool for parallel tools, model-ordered result
 * commit, and abort-time synthetic results for skipped calls.
 *
 * Every started call is durably logged as `tool/call` and every settled call as
 * `tool/result` — so replay stays valid even across cancellation.
 */

import type { EventLog } from './event-log.ts';
import type { ToolCall, UserMessage } from './types.ts';
import type { ToolRegistry } from './tools/registry.ts';
import {
  parseArguments,
  validate,
  type AgentHandle,
  type ToolExecutionResult,
} from './tools/types.ts';

export interface SchedulerInput {
  log: EventLog;
  registry: ToolRegistry;
  agent: AgentHandle;
  turn: number;
  step: number;
  toolCalls: ToolCall[];
  signal: AbortSignal;
  maxParallelToolCalls: number;
  /** Accepts model-visible context produced by a tool result. */
  acceptContext: (message: UserMessage) => void;
}

interface PlannedCall {
  block: ToolCall;
  args: unknown;
  /** Present when argument validation failed; short-circuits execution. */
  validationError?: string;
  callSeq: number;
}

function errorResult(message: string): ToolExecutionResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export async function executeToolCalls(input: SchedulerInput): Promise<{ concluded: boolean }> {
  const { registry } = input;
  const planned: PlannedCall[] = input.toolCalls.map((block) => {
    const tool = registry.get(block.name);
    let validationError: string | undefined;
    if (!tool) {
      validationError = `Tool "${block.name}" not found`;
    } else {
      const result = validate(tool.parameters, parseArguments(block.arguments));
      if (!result.ok) validationError = result.errors.join('; ');
    }
    return { block, args: parseArguments(block.arguments), validationError, callSeq: -1 };
  });

  let concluded = false;
  let next = 0;

  while (next < planned.length) {
    const mode = registry.executionMode(planned[next]!.block.name);

    const outcome =
      mode === 'sequential'
        ? await runSequential(input, [planned[next]!])
        : await runPool(input, collectParallel(planned, next, registry));

    concluded ||= outcome.concluded;
    next += outcome.consumed;

    if (outcome.aborted) {
      // Fill synthetic results for every call after the drained group.
      for (const call of planned.slice(next)) {
        appendSkipped(input, call);
      }
      break;
    }
  }

  return { concluded };
}

/** Collect the maximal run of parallel-mode calls starting at `from`. */
function collectParallel(planned: PlannedCall[], from: number, registry: ToolRegistry): PlannedCall[] {
  const group: PlannedCall[] = [];
  for (let i = from; i < planned.length; i++) {
    const call = planned[i]!;
    if (registry.executionMode(call.block.name) !== 'parallel') break;
    group.push(call);
  }
  return group;
}

// ---------------------------------------------------------------------------
// Sequential: an exclusive barrier of one.
// ---------------------------------------------------------------------------

async function runSequential(
  input: SchedulerInput,
  group: PlannedCall[],
): Promise<{ consumed: number; aborted: boolean; concluded: boolean }> {
  const call = group[0]!;
  if (input.signal.aborted) {
    appendSkipped(input, call);
    return { consumed: group.length, aborted: true, concluded: false };
  }
  const result = await settle(input, call);
  return { consumed: 1, aborted: input.signal.aborted, concluded: result.concludesTurn === true };
}

// ---------------------------------------------------------------------------
// Parallel: bounded rolling pool, model-ordered commit.
// ---------------------------------------------------------------------------

async function runPool(
  input: SchedulerInput,
  group: PlannedCall[],
): Promise<{ consumed: number; aborted: boolean; concluded: boolean }> {
  const { signal, maxParallelToolCalls } = input;
  const slots: (ToolExecutionResult | undefined)[] = group.map(() => undefined);
  const inFlight = new Map<number, Promise<number>>();
  let nextToStart = 0;
  let committed = 0;
  let aborted = signal.aborted;
  let concluded = false;

  const commitReady = (): void => {
    while (committed < group.length) {
      const result = slots[committed];
      if (result === undefined) break;
      appendResult(input, group[committed]!, result);
      concluded ||= result.concludesTurn === true;
      committed += 1;
    }
  };

  const startCall = (index: number): void => {
    const promise = settle(input, group[index]!).then((result) => {
      slots[index] = result;
      return index;
    });
    inFlight.set(index, promise);
  };

  const fillPool = (): void => {
    while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
      startCall(nextToStart);
      nextToStart += 1;
    }
  };

  fillPool();
  while (inFlight.size > 0) {
    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled);
    commitReady();
    if (signal.aborted) aborted = true;
    fillPool();
  }
  commitReady();

  if (aborted) {
    for (let i = nextToStart; i < group.length; i++) {
      appendSkipped(input, group[i]!);
    }
  }

  return { consumed: group.length, aborted, concluded };
}

// ---------------------------------------------------------------------------
// Per-call settlement: log the call, validate, execute, normalize errors.
// ---------------------------------------------------------------------------

async function settle(input: SchedulerInput, call: PlannedCall): Promise<ToolExecutionResult> {
  const { registry, agent, signal } = input;

  // Durably log the call before any execution, in model order.
  call.callSeq = appendToolCall(input, call);

  if (call.validationError) {
    return errorResult(call.validationError);
  }

  const tool = registry.get(call.block.name);
  if (!tool) {
    return errorResult(`Tool "${call.block.name}" not found`);
  }

  try {
    return await tool.execute({
      callId: call.block.id,
      name: call.block.name,
      arguments: call.args,
      agent,
      signal,
    });
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}

function appendToolCall(input: SchedulerInput, call: PlannedCall): number {
  const logged = input.log.append({
    type: 'tool/call',
    turn: input.turn,
    step: input.step,
    callId: call.block.id,
    name: call.block.name,
    arguments: call.block.arguments,
  });
  return logged.seq;
}

function appendResult(input: SchedulerInput, call: PlannedCall, result: ToolExecutionResult): void {
  input.log.append({
    type: 'tool/result',
    turn: input.turn,
    step: input.step,
    message: {
      role: 'toolResult',
      toolCallId: call.block.id,
      toolName: call.block.name,
      content: result.content,
      isError: result.isError,
      timestamp: Date.now(),
    },
    callSeq: call.callSeq,
  });
  for (const context of result.additionalContext ?? []) {
    input.acceptContext(context);
  }
}

function appendSkipped(input: SchedulerInput, call: PlannedCall): void {
  if (call.callSeq === -1) call.callSeq = appendToolCall(input, call);
  appendResult(input, call, errorResult('Error: tool call aborted before dispatch'));
}