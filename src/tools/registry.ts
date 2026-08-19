/**
 * Tool registry. Registration returns a disposer (reversible effect).
 */

import type { ModelTool } from '../llm/types.ts';
import { toModelTool, type ToolDefinition, type ToolExecutionMode } from './types.ts';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): () => void {
    this.tools.set(tool.name, tool);
    return () => this.tools.delete(tool.name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  executionMode(name: string): ToolExecutionMode {
    return this.tools.get(name)?.executionMode ?? 'parallel';
  }

  toModelTools(): ModelTool[] {
    return this.list().map(toModelTool);
  }
}