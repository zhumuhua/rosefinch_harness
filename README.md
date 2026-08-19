# Rosefinch Harness

An agent runtime skeleton that combines the best of two frameworks:

- **Pi** (`@earendil-works/pi-*`): a unified multi-provider LLM stream abstraction and an ergonomic, readable state class.
- **DeepSeek Harness** (`@deepseek-ai/dsh`): an append-only event-sourced session log as the single source of truth, waterfall plugin extension points, and a production-grade tool scheduler.

## Design spine

1. **Log is the source of truth, projection is the face.** Every turn/step/message/tool event lands in an append-only `EventLog` with a monotonic `seq`. A `Projection` derives a friendly in-memory view. Invariant: *model-visible ⟺ logged* — anything the model sees must be reconstructable from the log (`EventLog.deriveMessages()`).
2. **Thin loop + waterfall decision points.** One zero-hardcoding driver with an explicit `Phase` state machine (`idle | running | maintenance`) and `turn`/`step` boundaries. Extension happens at `pre-step`, `request`, and `request-error` waterfalls — never by patching the loop.
3. **Unified LLM stream.** A `stream(model, context, options) -> AsyncIterable<StreamEvent>` shape with a script-driven fake adapter, so the whole pipeline runs end-to-end with no API key.
4. **Tool scheduler.** Exclusive barriers + a bounded rolling parallel pool, model-ordered result commit, and abort-time synthetic results for skipped calls.

## Layout

```
src/
  types.ts          messages, session events, SessionEventMap (declaration-merging)
  event-log.ts      append-only log + seq + deriveMessages()
  projection.ts     incremental in-memory projection
  dispatch.ts       HookEventMap + emit/waterfall/parallel/serial + disposers
  inbox.ts          steer / followUp / inject
  llm/              Model/StreamEvent types + script-driven fake adapter + OpenAI-compatible adapter
  tools/            JSON-schema + validate + ToolExecution types + registry
  scheduler.ts      tool scheduler (barrier + rolling pool + synthetic results)
  tokens.ts         token estimation heuristic
  compactor.ts      context compaction (summary + keepRecent, cached)
  loop.ts           thin driver with Phase state machine (incl. maintenance)
  agent.ts          public Agent facade
  extensions.ts     ergonomic extension API (defineTool)
  index.ts          public exports
examples/demo.ts    end-to-end run
test/               unit + e2e tests
```

## Run

```sh
npm install
npm run demo      # end-to-end: scripted LLM triggers tool calls, full loop runs
npm test          # vitest
npm run typecheck
```

## Using a real model

Swap the fake adapter for the zero-dependency OpenAI-compatible one (works
with OpenAI, DeepSeek, and most gateways by pointing `baseUrl` at them):

```ts
import { Agent, openAiAdapter } from './src/index.ts';

const agent = new Agent({
  model: { provider: 'openai', id: 'gpt-4o-mini', contextWindow: 128_000, maxTokens: 4096 },
  adapter: openAiAdapter({ apiKey: process.env.OPENAI_API_KEY }),
});

await agent.prompt('Hello!');
```

## Context compaction

Pass `compaction: true` (or a tuning object) to enable the maintenance phase:
when the estimated history exceeds 80% of `contextWindow`, the oldest messages
are summarized into a preamble and only the most recent are sent verbatim. The
append-only log never loses a message — compaction is a derived, model-facing
view recorded as a `history/compact` event.

```ts
const agent = new Agent({
  model,
  adapter,
  compaction: { keepRecent: 6, triggerTokens: 100_000 },
});
```