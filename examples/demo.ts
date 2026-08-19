/**
 * End-to-end run: a scripted fake LLM first emits a tool call, a weather tool
 * resolves it and stages a bridging message, then the model answers with final
 * text — all through the real driver loop with no API key.
 *
 * Run: `npm run demo`
 */

import { Agent } from '../src/agent.ts';
import { fakeAdapter } from '../src/llm/fake.ts';

const adapter = fakeAdapter({
  replies: [
    // Turn 1, step 1: ask for weather via a tool call.
    { toolCalls: [{ id: 'c1', name: 'get_weather', arguments: '{"city":"Beijing"}' }] },
    // Turn 1, step 2: final answer after the tool result is in context.
    { text: 'Beijing is 22°C and clear today.' },
  ],
});

const agent = new Agent({
  model: { provider: 'fake', id: 'fake-1', contextWindow: 4000, maxTokens: 256 },
  adapter,
});

agent.log.subscribe(({ seq, event }) => {
  console.log(`  ${String(seq).padStart(2, '0')}  ${event.type}`);
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
    return {
      content: [{ type: 'text', text: `${city ?? 'unknown'}: 22°C, clear` }],
      isError: false,
    };
  },
});

console.log('events:');
await agent.prompt("What's the weather in Beijing?");

console.log('\nprojected history:');
for (const message of agent.projection.messages) {
  const text =
    message.role === 'toolResult'
      ? message.content.map((b) => b.text).join('')
      : message.content.map((b) => (b.type === 'text' ? b.text : `<${b.type}>`)).join('');
  console.log(`  ${message.role.padEnd(10)} ${text}`);
}