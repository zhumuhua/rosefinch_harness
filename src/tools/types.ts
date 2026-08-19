/**
 * Tool vocabulary. The definition surface is Pi-style (small, ergonomic); the
 * execution scheduling (exclusive barrier + parallel pool) lives in
 * scheduler.ts and is DeepSeek-Harness-style.
 */

import type { TextBlock, UserMessage } from '../types.ts';
import type { ModelTool } from '../llm/types.ts';

// ---------------------------------------------------------------------------
// Minimal JSON schema (declarative only; validation is a plain recursive walk)
// ---------------------------------------------------------------------------

export type JsonSchema =
  | { type: 'string'; description?: string }
  | { type: 'number'; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'object'; description?: string; properties?: Record<string, JsonSchema>; required?: string[] };

export type ValidateResult = { ok: true; value: unknown } | { ok: false; errors: string[] };

export function validate(schema: JsonSchema, value: unknown, path = '$'): ValidateResult {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, errors: [`${path}: expected string, got ${typeof value}`] };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, errors: [`${path}: expected number, got ${typeof value}`] };
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, errors: [`${path}: expected boolean, got ${typeof value}`] };
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ok: false, errors: [`${path}: expected object`] };
      }
      const errors: string[] = [];
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in record)) errors.push(`${path}.${key}: missing required property`);
      }
      for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
        if (key in record) {
          const result = validate(subSchema, record[key], `${path}.${key}`);
          if (!result.ok) errors.push(...result.errors);
        }
      }
      return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
    }
  }
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export type ToolExecutionMode = 'parallel' | 'sequential';

/** The subset of an agent a tool may bind to (avoiding a hard import cycle). */
export interface AgentHandle {
  readonly id: string;
  /** Stage model-visible context that lands in a later step without waking the driver. */
  inject(message: UserMessage): void;
}

export interface ToolExecutionInput {
  callId: string;
  name: string;
  /** Parsed/validated arguments. */
  arguments: unknown;
  agent: AgentHandle;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  content: TextBlock[];
  isError: boolean;
  /** When true, end the turn after this batch commits (Pi's `terminate`). */
  concludesTurn?: boolean;
  /** Extra model-visible messages produced by the tool (DSH's result context). */
  additionalContext?: UserMessage[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  /**
   * 'sequential' tools form exclusive barriers: they run alone.
   * 'parallel' (default) tools share a bounded rolling pool.
   */
  executionMode?: ToolExecutionMode;
  execute(input: ToolExecutionInput): Promise<ToolExecutionResult> | ToolExecutionResult;
}

export function toModelTool(tool: ToolDefinition): ModelTool {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** Parse raw model arguments, mapping invalid JSON to the raw text. */
export function parseArguments(raw: string): unknown {
  try {
    return raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    return raw;
  }
}