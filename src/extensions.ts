/**
 * Extension helpers. Tools are the primary extension seam: `defineTool` builds
 * a {@link ToolDefinition} and registers it on the agent, returning a disposer
 * (reversible effects — DeepSeek-Harness-style).
 */

import type { JsonSchema, ToolDefinition, ToolExecutionMode } from './tools/types.ts';

export interface DefineToolInput {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** 'sequential' tools become exclusive barriers; default 'parallel'. */
  executionMode?: ToolExecutionMode;
  execute: ToolDefinition['execute'];
}

export interface ToolHost {
  tools: { register(tool: ToolDefinition): () => void };
}

/** Register a tool and return a disposer that removes it. */
export function defineTool(agent: ToolHost, input: DefineToolInput): () => void {
  const tool: ToolDefinition = {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    executionMode: input.executionMode,
    execute: input.execute,
  };
  return agent.tools.register(tool);
}