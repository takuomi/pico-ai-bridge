import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readConfig } from '../server/core/config.js';
import { callTool, createContext, publicTools } from '../server/core/registry.js';
import { fixture } from './fixtures.js';
import { v1Models, apiTags, apiShow, apiVersion, generations } from './fixtures-pico.js';
const replies = {
  '/api/version': apiVersion,
  '/v1/models': v1Models,
  '/api/tags': apiTags,
  '/api/show': apiShow,
  '/v1/responses': generations.responsesPlain.response,
  '/v1/chat/completions': generations.chatPlain.response,
  '/api/chat': generations.ollamaPlain.response
};
test('public tools match the checked-in tool contract', () => {
  const contract = JSON.parse(readFileSync(new URL('./tools-contract.json', import.meta.url), 'utf8'));
  assert.deepEqual(publicTools(), contract);
});
test('each tool has default and raw shapes; POST extra adds fields', async () => {
  const f = await fixture(call => ({ body: call.path === '/api/show' ? replies['/api/show'][call.body.model] : replies[call.path] }));
  try {
    for (const [name, args, path] of [
      ['pico_server_info', {}, '/api/version'], ['pico_list_models', { include_capabilities: true }, '/api/tags'],
      ['pico_responses', { input: 'hi' }, '/v1/responses'], ['pico_chat_completions', { prompt: 'hi' }, '/v1/chat/completions'],
      ['pico_ollama_chat', { prompt: 'hi' }, '/api/chat']
    ]) {
      const normal = await callTool(name, args, f.ctx); assert.equal(normal.isError, undefined, name);
      const raw = await callTool(name, { ...args, raw: true, ...(path.startsWith('/v1/') && path !== '/v1/models' || path === '/api/chat' ? { extra: { custom: 7 } } : {}) }, f.ctx);
      assert.equal(raw.isError, undefined, name);
      if (name === 'pico_list_models') {
        assert.deepEqual(normal.structuredContent.models.map(model => model.name), v1Models.data.map(model => `${model.id}:latest`));
        assert.deepEqual(raw.structuredContent.v1_models.body, replies['/v1/models']);
        assert.deepEqual(raw.structuredContent.api_tags.body, replies['/api/tags']);
        for (const [model, body] of Object.entries(apiShow)) assert.deepEqual(raw.structuredContent.api_show[model].body, body);
      }
      else { assert.deepEqual(raw.structuredContent.body, replies[path]); assert.equal(raw.structuredContent.status, 200); }
    }
    assert.equal('model' in f.calls.find(x => x.body?.custom === 7).body, false);
    assert.equal((await callTool('pico_responses', { input: 'hi' }, f.ctx)).structuredContent.answer, 'The sky appears blue on a clear day.');
    assert.equal((await callTool('pico_chat_completions', { prompt: 'hi', split_thinking: false }, f.ctx)).structuredContent.answer, 'The sky appears a bright, clear blue on a clear day.');
    assert.equal((await callTool('pico_ollama_chat', { prompt: 'hi' }, f.ctx)).structuredContent.durations_ms.total, 11329);
  } finally { await f.close(); }
});

test('empty strings are valid generation inputs', async () => {
  const f = await fixture(call => ({ body: call.path === '/v1/responses' ? { output: [] } : call.path === '/api/chat' ? { message: { role: 'assistant', content: '' } } : { choices: [{ message: { role: 'assistant', content: '' } }] } }));
  try {
    await callTool('pico_chat_completions', { prompt: '' }, f.ctx);
    await callTool('pico_ollama_chat', { prompt: '' }, f.ctx);
    await callTool('pico_responses', { input: '' }, f.ctx);
    assert.deepEqual(f.calls.map(call => call.body), [
      { messages: [{ role: 'user', content: '' }], stream: false },
      { messages: [{ role: 'user', content: '' }], stream: false },
      { stream: false, input: '' }
    ]);
  } finally { await f.close(); }
});
test('compare is sequential and raw rows contain Pico bodies', async () => {
  let active = 0, maximum = 0;
  const f = await fixture(async call => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 50));
    active--;
    return { body: replies[call.path] };
  });
  const ctx = createContext(readConfig({ PICO_BASE_URL: f.config.baseUrl, PICO_MAX_CONCURRENT_REQUESTS: '2' }));
  try {
    const args = { models: ['a', 'b'], prompt: 'hi', reasoning: 'none', extra: { custom: 1 } };
    const normal = await callTool('pico_compare_models', args, ctx);
    assert.equal(normal.structuredContent.results.length, 2);
    assert.equal(normal.structuredContent.results[0].answer, 'The sky appears a bright, clear blue on a clear day.');
    assert.equal(normal.structuredContent.results[0].response_model, replies['/v1/chat/completions'].model ?? null);
    assert.deepEqual(normal.structuredContent.results[0].tool_calls, []);
    assert.equal(normal.structuredContent.results[0].finish_reason, replies['/v1/chat/completions'].choices[0].finish_reason ?? null);
    const raw = await callTool('pico_compare_models', { ...args, raw: true }, ctx);
    assert.deepEqual(raw.structuredContent.results[0].body, replies['/v1/chat/completions']);
    assert.deepEqual(f.calls.map(x => x.body.model), ['a', 'b', 'a', 'b']);
    assert.equal(maximum, 1);
    assert.equal(f.calls[0].body.reasoning_effort, 'none'); assert.equal(f.calls[0].body.custom, 1);
  } finally { await f.close(); }
});
test('extra model is accepted when model is omitted', async () => {
  const f = await fixture(call => ({ body: replies[call.path] }));
  try {
    await callTool('pico_responses', { input: 'hi', extra: { model: 'x' }, raw: true }, f.ctx);
    await callTool('pico_chat_completions', { prompt: 'hi', extra: { model: 'x' }, raw: true }, f.ctx);
    await callTool('pico_ollama_chat', { prompt: 'hi', extra: { model: 'x' }, raw: true }, f.ctx);
    assert.deepEqual(f.calls.map(x => x.body.model), ['x', 'x', 'x']);
    assert.equal(f.calls[0].body.input, 'hi');
    assert.equal(f.calls[1].body.messages[0].content, 'hi');
  } finally { await f.close(); }
});
test('extra conflicts reject the call before Pico receives it', async () => {
  const f = await fixture(call => ({ body: replies[call.path] }));
  try {
    for (const [name, args, keys] of [
      ['pico_responses', { input: 'hi', model: 'a', extra: { model: 'b', input: 'other' } }, ['model', 'input']],
      ['pico_responses', { input: 'hi', json_schema: { type: 'object' }, json_schema_name: 'answer', extra: { text: {} } }, ['text']],
      ['pico_responses', { input: 'hi', tools: [], extra: { tools: [] } }, ['tools']],
      ['pico_chat_completions', { prompt: 'hi', max_tokens: 8, extra: { stream: true, max_tokens: 9 } }, ['stream', 'max_tokens']],
      ['pico_chat_completions', { prompt: 'hi', tools: [], extra: { tools: [] } }, ['tools']],
      ['pico_chat_completions', { system: 'policy', extra: { messages: [{ role: 'user', content: 'hi' }] } }, ['messages']],
      ['pico_ollama_chat', { prompt: 'hi', extra: { stream: true, messages: [] } }, ['stream', 'messages']],
      ['pico_ollama_chat', { prompt: 'hi', format: 'json', extra: { format: 'other' } }, ['format']],
      ['pico_ollama_chat', { prompt: 'hi', tools: [], extra: { tools: [] } }, ['tools']],
      ['pico_compare_models', { models: ['a', 'b'], prompt: 'hi', extra: { model: 'override' } }, ['model']]
    ]) {
      const response = await callTool(name, args, f.ctx);
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent.kind, 'invalid_arguments');
      for (const key of keys) assert.match(response.structuredContent.message, new RegExp(key));
      assert.match(response.structuredContent.message, /use |fixed to false/);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('extra conflict guidance names the calling tool arguments', async () => {
  const f = await fixture(call => ({ body: replies[call.path] }));
  try {
    for (const [name, args, message] of [
      ['pico_compare_models', { models: ['a', 'b'], prompt: 'hi', api: 'responses', extra: { input: 'other' } }, 'extra conflicts with input (use prompt or messages).'],
      ['pico_compare_models', { models: ['a', 'b'], prompt: 'hi', api: 'ollama', temperature: 0.5, extra: { options: {} } }, 'extra conflicts with options (use options, max_tokens or temperature).'],
      ['pico_responses', { input: 'hi', extra: { input: 'other' } }, 'extra conflicts with input (use input).'],
      ['pico_responses', { input: 'hi', json_schema: { type: 'object' }, json_schema_name: 'answer', extra: { text: {} } }, 'extra conflicts with text (use json_schema and json_schema_name).'],
      ['pico_chat_completions', { prompt: 'hi', reasoning_effort: 'low', extra: { reasoning_effort: 'high' } }, 'extra conflicts with reasoning_effort (use reasoning_effort).'],
      ['pico_responses', { input: 'hi', reasoning_effort: 'low', extra: { reasoning: {} } }, 'extra conflicts with reasoning (use reasoning_effort).'],
      ['pico_compare_models', { models: ['a', 'b'], prompt: 'hi', api: 'responses', reasoning: 'low', extra: { reasoning: {} } }, 'extra conflicts with reasoning (use reasoning).'],
      ['pico_ollama_chat', { prompt: 'hi', options: { seed: 1 }, extra: { options: {} } }, 'extra conflicts with options (use options).']
    ]) {
      const response = await callTool(name, args, f.ctx);
      assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'invalid_arguments', message });
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('comparison maps reasoning for each API', async () => {
  const f = await fixture(call => ({ body: replies[call.path] }));
  try {
    for (const [api, reasoning, field, expected] of [
      ['chat_completions', 'xhigh', 'reasoning_effort', 'xhigh'],
      ['chat_completions', 'unexpected', 'reasoning_effort', 'unexpected'],
      ['responses', 'high', 'reasoning', { effort: 'high' }],
      ['responses', 'custom-effort', 'reasoning', { effort: 'custom-effort' }],
    ]) {
      const before = f.calls.length;
      await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi', api, reasoning }, f.ctx);
      for (const { body } of f.calls.slice(before, before + 2)) {
        assert.deepEqual(body[field], expected);
        if (api === 'responses') assert.equal('reasoning_effort' in body, false);
      }
    }
  } finally { await f.close(); }
});
test('comparison sends Ollama think, extra.think, and merged options', async () => {
  const errorBody = { error: 'Type mismatch for `think` key, expected `Bool` type.' };
  const f = await fixture(call => call.body.think === 'low' ? { status: 400, body: errorBody } : { body: replies[call.path] });
  try {
    for (const value of ['low', null]) {
      assert.deepEqual((await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi', api: 'ollama', think: value }, f.ctx)).structuredContent,
        { source: 'bridge', kind: 'invalid_arguments', message: 'arguments.think must be boolean' });
    }
    assert.equal(f.calls.length, 0);
    for (const think of [true, false, 'low', null]) {
      const before = f.calls.length;
      const response = await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi', api: 'ollama', ...(typeof think === 'boolean' ? { think } : { extra: { think } }), options: { seed: 7 }, max_tokens: 0, temperature: 0 }, f.ctx);
      for (const { body } of f.calls.slice(before)) {
        assert.equal(body.think, think);
        assert.deepEqual(body.options, { seed: 7, num_predict: 0, temperature: 0 });
      }
      for (const row of response.structuredContent.results) {
        if (think === 'low') assert.deepEqual(row.error, { source: 'pico', status: 400, body: errorBody });
        else assert.equal(row.error, undefined);
      }
    }
  } finally { await f.close(); }
});
test('extra can supply payload fields the bridge does not send', async () => {
  const f = await fixture(call => ({ body: replies[call.path] }));
  try {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
    const messages = [{ role: 'user', content: 'hi' }];
    await callTool('pico_responses', { extra: { input } }, f.ctx);
    await callTool('pico_chat_completions', { extra: { messages } }, f.ctx);
    await callTool('pico_ollama_chat', { extra: { messages } }, f.ctx);
    assert.deepEqual(f.calls.map(call => call.body.model), [undefined, undefined, undefined]);
    assert.deepEqual(f.calls[0].body.input, input);
    assert.deepEqual(f.calls[1].body.messages, messages);
    assert.deepEqual(f.calls[2].body.messages, messages);
  } finally { await f.close(); }
});

test('extra conflicts precede missing image reads for every POST tool and comparison API', async () => {
  const f = await fixture(() => ({ body: {} }));
  try {
    for (const [name, args, message] of [
      ['pico_responses', { input: 'hi', extra: { input: 'other' } }, 'extra conflicts with input (use input).'],
      ['pico_chat_completions', { prompt: 'hi', extra: { messages: [] } }, 'extra conflicts with messages (use prompt or messages).'],
      ['pico_ollama_chat', { prompt: 'hi', extra: { messages: [] } }, 'extra conflicts with messages (use prompt or messages).'],
      ...['responses', 'chat_completions', 'ollama'].map(api => ['pico_compare_models', { api, models: ['a', 'b'], prompt: 'hi', extra: { model: 'x' } }, 'extra conflicts with model (use models).'])
    ]) {
      const response = await callTool(name, { ...args, images: ['/pico-ai-bridge-nonexistent/image.png'] }, f.ctx);
      assert.equal(response.isError, true);
      assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'invalid_arguments', message });
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('prompt conflicts with messages before image reads or Pico requests', async () => {
  const f = await fixture(() => ({ body: {} }));
  try {
    for (const [name, args, message] of [
      ['pico_chat_completions', { prompt: 'hi', messages: [] }, 'Provide either prompt or messages, not both.'],
      ['pico_ollama_chat', { prompt: 'hi', messages: [] }, 'Provide either prompt or messages, not both.'],
    ]) {
      const response = await callTool(name, { ...args, images: ['/pico-ai-bridge-nonexistent/image.png'] }, f.ctx);
      assert.equal(response.isError, true);
      assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'invalid_arguments', message });
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('chat and Ollama tools pass tool definitions through unchanged', async () => {
  const expected = [{ type: 'function', function: { name: 'f', parameters: { type: 'object' }, strict: true }, custom_field: 1 }, { type: 'custom_kind' }];
  const f = await fixture(call => ({ body: call.path === '/api/chat' ? { message: { role: 'assistant', content: '' } } : { choices: [{ message: { role: 'assistant', content: '' } }] } }));
  try {
    await callTool('pico_chat_completions', { prompt: 'hi', tools: expected }, f.ctx);
    await callTool('pico_ollama_chat', { prompt: 'hi', tools: expected }, f.ctx);
    assert.deepEqual(f.calls.map(call => call.body.tools), [expected, expected]);
  } finally { await f.close(); }
});

test('spec-shaped synthetic thinking forms and separate reasoning match in single tools and comparisons', async () => {
  for (const [api, name, input, body, separate] of [
    ['chat_completions', 'pico_chat_completions', { prompt: 'hi' }, text => ({ choices: [{ message: { role: 'assistant', content: text, reasoning_content: 'first', reasoning: 'second' }, finish_reason: 'length' }] }), 'first\nsecond'],
    ['ollama', 'pico_ollama_chat', { prompt: 'hi' }, text => ({ message: { role: 'assistant', content: text, thinking: 'separate' }, done_reason: 'length' }), 'separate'],
    ['responses', 'pico_responses', { input: 'hi' }, text => ({ status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text }] }, { type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }], content: [{ type: 'reasoning_text', text: 'unused' }] }, { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'content' }] }, { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'empty summary' }] }] }), 'summary\ncontent\nempty summary']
  ]) {
    for (const [text, answer, reasoning] of [
      [' A <think> R </think> B ', ' A  B ', 'R'],
      [' R </think> A ', ' A ', 'R'],
      [' A <think> R ', ' A <think> R ', ''],
      ['<think> R ', '<think> R ', ''],
      ['<think> R </think> A <think>S</think> B ', ' A  B ', 'R\nS'],
      ['<think> </think>A', 'A', ''],
      [' A ', ' A ', ''],
      ['<reasoning>R</reasoning>A', '<reasoning>R</reasoning>A', ''],
      ['orphan</think>A<think>pair</think>B<think>tail', 'AB<think>tail', 'orphan\npair'],
      ['<think>first</think>middle</think>answer', 'middle</think>answer', 'first']
    ]) {
      const f = await fixture(() => ({ body: body(text) }));
      try {
        for (const split_thinking of [true, false]) {
          const normal = await callTool(name, { ...input, split_thinking }, f.ctx);
          assert.equal(normal.isError, undefined);
          assert.equal(normal.structuredContent.answer, split_thinking ? answer : text);
          const expected = [split_thinking ? reasoning : '', separate].filter(Boolean).join('\n');
          assert.equal(normal.structuredContent.reasoning, expected);
          assert.equal(normal.structuredContent[name === 'pico_responses' ? 'status' : 'finish_reason'], name === 'pico_responses' ? 'incomplete' : 'length');
          const compared = await callTool('pico_compare_models', { api, models: ['a', 'b'], prompt: 'hi', split_thinking }, f.ctx);
          for (const row of compared.structuredContent.results) {
            assert.equal(row.answer, split_thinking ? answer : text);
            assert.equal(row.reasoning, expected);
            assert.equal(row.response_model, null);
            assert.equal(row[api === 'responses' ? 'status' : 'finish_reason'], api === 'responses' ? 'incomplete' : 'length');
          }
        }
      } finally { await f.close(); }
    }
  }
});
