# Rosefinch Harness

一个 Agent 运行时骨架（TypeScript），把两套框架的优点拼在一个精简内核里：

- **Pi**（`@earendil-works/pi-*`）：统一的多 provider LLM 流抽象，以及一个可读性强的状态类。
- **DeepSeek Harness**（`@deepseek-ai/dsh`）：追加式的、事件溯源的会话日志作为唯一事实来源；瀑布式插件扩展点；一个生产级的工具调度器。

没有任何运行时依赖：LLM 适配器用原生 `fetch`，整个流水线可以用脚本驱动的 fake 适配器无 API key 跑通。

---

## 特性一览

- **日志即真相，投影只是表象** —— 每条事件追加进 `EventLog`（单调递增的 `seq`），模型面对的视图由 `deriveMessages()` 从日志重建。不变式：*模型可见 ⟺ 已入日志*。
- **薄循环 + 瀑布式决策点** —— 一个零硬编码的驱动，带显式 `Phase` 状态机（`idle | running | maintenance`）和 `turn`/`step` 边界；扩展通过 `pre-step` / `request` / `request-error` 三个瀑布点完成，而不是改动循环。
- **统一 LLM 流** —— `stream(model, context, options) -> AsyncIterable<StreamEvent>`，配套脚本驱动的 fake 适配器与零依赖的 OpenAI 兼容适配器。
- **工具调度器** —— 顺序工具走独占屏障，并行工具走有界滚动池；结果按模型输出顺序提交；中断时为被跳过的调用写入合成结果。
- **消息收件箱（Inbox）** —— `steer`（下一步 + 唤醒）、`followUp`（下一轮 + 唤醒）、`inject`（下一步、不唤醒）三种投递语义。
- **上下文压缩** —— 通过 maintenance 阶段把超长历史折叠成摘要前导消息，日志本身永不丢消息。
- **可逆扩展** —— 所有注册（工具、瀑布处理器、emit 订阅、日志订阅）都返回 disposer。

---

## 设计主干

1. **日志是唯一事实来源，投影是它的脸。** 每个 turn/step/message/tool 事件都追加进只增的 `EventLog`，带单调递增的 `seq`。`Projection` 从中派生一个友好的内存视图。不变式：*模型可见 ⟺ 已入日志*——模型看到的任何东西都能从日志重建（见 `EventLog.deriveMessages()`）。
2. **薄循环 + 瀑布式决策点。** 显式的 `Phase` 状态机和 `turn`/`step` 边界上，扩展发生在 `pre-step`、`request`、`request-error` 三个瀑布点——绝不靠打补丁改循环。
3. **统一 LLM 流。** `stream(model, context, options) -> AsyncIterable<StreamEvent>` 的形态 + 脚本驱动的 fake 适配器，让整条流水线在无 API key 的情况下端到端跑通。
4. **工具调度器。** 独占屏障 + 有界滚动并行池、按模型顺序提交结果、中断时为被跳过的调用生成合成结果。

---

## 快速开始

```sh
npm install
npm run demo       # 端到端：脚本化 LLM 触发工具调用，完整循环跑通
npm test           # vitest
npm run typecheck
```

要求 Node >= 20，ESM，TypeScript 严格模式。

### 最小示例（无 API key）

```ts
import { Agent } from './src/index.ts';
import { fakeAdapter } from './src/index.ts';

const agent = new Agent({
  model: { provider: 'fake', id: 'fake-1', contextWindow: 8000, maxTokens: 256 },
  adapter: fakeAdapter({
    replies: [
      // 第 1 步：让模型发起一次工具调用
      { toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"Beijing"}' }] },
      // 第 2 步：拿到工具结果后给出最终回答
      { text: 'Beijing is 22°C and clear today.' },
    ],
  }),
});

agent.tools.register({
  name: 'get_weather',
  description: 'Return the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
  async execute({ arguments: args }) {
    const { city } = args as { city?: string };
    return { content: [{ type: 'text', text: `${city ?? '?'}: 22°C, clear` }], isError: false };
  },
});

await agent.prompt("What's the weather in Beijing?");
```

---

## 核心概念

### EventLog 与 Projection

`EventLog` 是只增的会话事件序列，每条事件都有一个单调递增的 `seq`，从不修改或删除。三类消息事件（`user/message`、`assistant/message`、`tool/result`）是“持久”的，`deriveMessages()` 逐条重放它们、重建模型可见的历史——这就是 ground truth。

`Projection` 是日志的一个派生便利视图（Pi 风格的 `AgentState`），从日志同步更新、从不回写。它维护 `messages`、累计 `usage`、`currentTurn`/`currentStep`，并提供 `lastMessage`。晚订阅者会收到已入日志事件的回放，从而收敛到一致状态。

### Phase 状态机与 turn/step

`Driver`（见 `src/loop.ts`）只有三种相位：

- `idle` —— 空闲，等待输入。
- `running` —— 正在跑 turn/step 循环。
- `maintenance` —— 正在做上下文压缩（临时挂起正常 turn）。

一个 *turn* 内部按 *step* 推进：每步先 claim 输入并经过 `pre-step` 判决（`enter | reject`），记录 `user/message`、发出 `request/header`、流式调用 LLM 得到 `assistant/message`，如果有工具调用就交给调度器拿到 `tool/result`。工具调用会触发 ReAct 风格的**自动续跑**——结果无需手动桥接就直接喂回模型进入下一步。

### 扩展点

`Dispatch` 暴露三个**瀑布式**决策点（种子值按注册顺序流过处理器，每个处理器可替换或透传它），以及观察者式 emit：

| 扩展点 | 形态 | 用途 |
| --- | --- | --- |
| `dispatch.onPreStep(handler)` | 瀑布 | 在一个 step 判决前拦截（enter / reject） |
| `dispatch.onRequest(handler)` | 瀑布 | 在发请求前改写 `RequestConfig`（provider/model/system/tools 等） |
| `dispatch.onRequestError(handler)` | 瀑布 | 请求失败时决定是否 `retry` |
| `dispatch.on(event, handler)` | 观察者 | 生命周期事件：`agent/start`、`agent/end`、`turn/start`、`turn/end`、`text/delta`、`tool/execution-start`、`tool/execution-end` |

每一个注册都返回 disposer，调用它即可撤销（可逆副作用）。

### Inbox：消息投递语义

`Agent` 暴露三种注入方式，对应 `Inbox` 的三种语义：

- `steer(text)` —— **下一步**：打断当前工作，并唤醒驱动。
- `followUp(text)` —— **下一轮**：在 agent 本应停止之后运行，并唤醒驱动。
- `inject(message)` —— **下一步但不唤醒**：等别的消息来唤醒驱动（工具通过 `AgentHandle.inject` 使用它）。

### 工具调度器

`executeToolCalls` 为工具调用提供两种执行模式：

- `sequential` —— 独占屏障，一次只跑一个。
- `parallel`（默认）—— 共享一个有界滚动池（`maxParallelToolCalls`，默认 4）。

结果**按模型输出的顺序提交**（而非完成顺序），保证 ReAct 循环是确定性的。中断时，尚未分派的调用会被登记为 `tool/call` 并追加合成的错误 `tool/result`，这样跨取消重放依然有效。

---

## LLM 适配器

统一的流抽象只有四种事件：

```ts
type StreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'done'; stopReason: StopReason; usage?: Usage }
  | { type: 'error'; message: string };
```

### 用真实模型

把 fake 适配器换成零依赖的 OpenAI 兼容适配器（把 `baseUrl` 指向 OpenAI、DeepSeek 或大多数网关即可复用）：

```ts
import { Agent, openAiAdapter } from './src/index.ts';

const agent = new Agent({
  model: { provider: 'openai', id: 'gpt-4o-mini', contextWindow: 128_000, maxTokens: 4096 },
  adapter: openAiAdapter({ apiKey: process.env.OPENAI_API_KEY }),
});

await agent.prompt('Hello!');
```

`openAiAdapter` 基于原生 `fetch`，解析 `/chat/completions` 的 SSE 协议，并把流式工具调用的片段拼接成完整调用。

---

## 编写工具

工具通过 JSON Schema 声明参数（`validate` 是一次朴素的递归遍历，不是完整 JSON Schema）：

```ts
agent.tools.register({
  name: 'get_weather',
  description: 'Return the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
  executionMode: 'parallel', // 默认；'sequential' 走独占屏障
  async execute({ callId, arguments: args, agent, signal }) {
    return {
      content: [{ type: 'text', text: '...' }],
      isError: false,
      // concludesTurn?: true       —— 本轮提交后结束 turn
      // additionalContext?: [...] —— 额外注入的模型可见消息（DSH 的 result context）
    };
  },
});
```

也可以用 `defineTool(agent, { ... })` 便捷函数注册并拿到 disposer。

---

## 上下文压缩

传入 `compaction: true`（或一个调参对象）即启用 maintenance 阶段：当估算历史超过 `contextWindow` 的 80% 时，最老的消息被同一个 LLM 适配器总结成一条前导消息，只有最近 `keepRecent` 条原样发送。总结结果按折叠的消息数缓存，稳态 step 不会重复总结。

追加式日志一条消息都不丢——压缩只是派生的、面向模型的视图，并作为 `history/compact` 事件记录在案。

```ts
const agent = new Agent({
  model,
  adapter,
  compaction: { keepRecent: 6, triggerTokens: 100_000 },
});
```

Token 估算（`src/tokens.ts`）是个廉价启发式：CJK 字符约 1 token，其余约 3.5 字符/token，外加每条消息的固定开销。

---

## 目录结构

```
src/
  types.ts          messages、session events、SessionEventMap（声明合并可扩展）
  event-log.ts      只增日志 + seq + deriveMessages()
  projection.ts     增量内存投影
  dispatch.ts       HookEventMap + emit/waterfall/parallel/serial + disposers
  inbox.ts          steer / followUp / inject
  llm/              Model/StreamEvent 类型 + 脚本化 fake 适配器 + OpenAI 兼容适配器
  tools/            JSON-schema + validate + ToolExecution 类型 + registry
  scheduler.ts      工具调度器（屏障 + 滚动池 + 合成结果）
  tokens.ts         token 估算启发式
  compactor.ts      上下文压缩（summary + keepRecent，带缓存）
  loop.ts           薄驱动 + Phase 状态机（含 maintenance）
  agent.ts          公开的 Agent 门面
  extensions.ts     顺手的扩展 API（defineTool）
  index.ts          公开导出
examples/demo.ts    端到端示例
test/               单元 + 端到端测试
```

公开 API 全部从 `src/index.ts` 扁平导出，消费方只需从一个地方 import。

---

## License

MIT