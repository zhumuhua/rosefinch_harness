/**
 * Public surface of rosefinch-harness.
 *
 * The layered dependency order is: types → event-log/projection → llm/tools →
 * dispatch/inbox → scheduler → loop → agent/extensions. Everything below is
 * re-exported flat, so consumers import from one place.
 */

// Core vocabulary + session event log
export {
  ZERO_USAGE,
  toolCallsOf,
  type TextBlock,
  type ThinkingBlock,
  type ToolCallBlock,
  type ContentBlock,
  type Usage,
  type StopReason,
  type UserMessage,
  type AssistantMessage,
  type ToolResultMessage,
  type Message,
  type ToolCall,
  type TurnEndReason,
  type SessionEventMap,
  type SessionEventType,
  type SessionEvent,
  type SessionEventOf,
} from './types.ts';
export {
  EventLog,
  type LoggedEvent,
  type LogSubscriber,
} from './event-log.ts';
export { Projection } from './projection.ts';

// LLM stream abstraction + fake adapter
export {
  type Model,
  type ModelTool,
  type LlmContext,
  type LlmOptions,
  type StreamEvent,
  type LlmStream,
  type LlmAdapter,
} from './llm/types.ts';
export {
  fakeAdapter,
  oneShot,
  type FakeReply,
  type FakeModelOptions,
} from './llm/fake.ts';
export { openAiAdapter, type OpenAiAdapterConfig } from './llm/openai.ts';

// Tools
export {
  validate,
  toModelTool,
  parseArguments,
  type JsonSchema,
  type ValidateResult,
  type ToolExecutionMode,
  type AgentHandle,
  type ToolExecutionInput,
  type ToolExecutionResult,
  type ToolDefinition,
} from './tools/types.ts';
export { ToolRegistry } from './tools/registry.ts';
export { executeToolCalls, type SchedulerInput } from './scheduler.ts';

// Extension dispatch
export {
  Dispatch,
  type Disposer,
  type PreStepContext,
  type PreStepDecision,
  type PreStepHandler,
  type RequestContext,
  type RequestConfig,
  type RequestHandler,
  type RequestErrorContext,
  type RequestErrorHandler,
  type EmitEventMap,
  type EmitEventName,
  type EmitHandler,
} from './dispatch.ts';
export { Inbox } from './inbox.ts';

// Token estimation + context compaction
export { estimateTokens, estimateMessages } from './tokens.ts';
export {
  Compactor,
  type CompactionOptions,
  type CompiledHistory,
} from './compactor.ts';

// Driver + agent facade
export { Driver, type DriverDeps, type Phase } from './loop.ts';
export { Agent, toUserMessage, type AgentOptions } from './agent.ts';
export { defineTool, type DefineToolInput, type ToolHost } from './extensions.ts';