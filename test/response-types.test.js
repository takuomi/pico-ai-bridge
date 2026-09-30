import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../server/core/registry.js';
import { fixture } from './fixtures.js';

const chat = () => ({ id: 'c', model: 'm', created: 1, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: {} });
const responses = () => ({ id: 'r', model: 'm', status: 'completed', created_at: 1, completed_at: 2, output: [], usage: { input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
const ollama = () => ({ model: 'm', created_at: 'now', done_reason: 'stop', done: true, prompt_eval_count: 1, eval_count: 1, message: { role: 'assistant', content: 'ok' } });
const cases = [
  ['pico_server_info', {}, '/api/version', () => ({ version: '1', name: 'Pico', build: 'b', bundle_identifier: 'id' }), [['version', 1], ['name', false], ['build', []], ['bundle_identifier', {}]]],
  ['pico_list_models', {}, '/v1/models', () => ({ data: [{ id: 'm', status: { value: 'ready' }, created: 1, owned_by: 'p' }], models: [{ model: 'm', name: 'M' }] }), [['data.0.status.value', 1], ['data.0.created', '1'], ['data.0.owned_by', false], ['models.0.model', 1], ['models.0.name', 1]]],
  ['pico_list_models', {}, '/api/tags', () => ({ models: [{ name: 'm', model: 'm', size: 1, modified_at: 'now', details: { format: 'gguf', family: 'x', parameter_size: '1', quantization_level: 'q' } }] }), [['models.0.model', 1], ['models.0.modified_at', 1], ['models.0.details.format', 1], ['models.0.details.family', 1], ['models.0.details.parameter_size', 1], ['models.0.details.quantization_level', 1]]],
  ['pico_list_models', { include_capabilities: true }, '/api/show', () => ({ capabilities: ['chat'], model_info: { 'x.context_length': 10 } }), [['capabilities', [1]], ['model_info', []], ['model_info.x.context_length', '10']]],
  ['pico_chat_completions', { prompt: 'hi' }, '/v1/chat/completions', chat, [['id', 1], ['model', 1], ['created', '1'], ['choices.0.finish_reason', 1], ['usage', []]]],
  ['pico_responses', { input: 'hi' }, '/v1/responses', responses, [['id', 1], ['model', 1], ['status', 1], ['created_at', '1'], ['completed_at', '2'], ['usage', []], ['usage.input_tokens', '1'], ['usage.output_tokens', '1'], ['usage.total_tokens', '1'], ['usage.prompt_time_ms', '1'], ['usage.generation_time_ms', '1'], ['usage.input_tokens_details', []], ['usage.output_tokens_details', []], ['usage.input_tokens_details.cached_tokens', '1'], ['usage.output_tokens_details.reasoning_tokens', '1'], ['error', []], ['incomplete_details', []], ['output.0.id', 1], ['output.0.status', 1]]],
  ['pico_ollama_chat', { prompt: 'hi' }, '/api/chat', ollama, [['model', 1], ['created_at', 1], ['done_reason', 1], ['done', 'yes'], ['prompt_eval_count', '1'], ['eval_count', '1'], ['total_duration', '1'], ['load_duration', '1'], ['prompt_eval_duration', '1'], ['eval_duration', '1'], ['message.tool_calls.0.id', 1]]]
];
function set(body, path, value) {
  const keys = path.split('.');
  let target = body;
  for (const key of keys.slice(0, -1)) target = target[key] ??= /^\d+$/.test(key) ? [] : {};
  target[keys.at(-1)] = value;
}
test('default mode validates extracted Pico field types and raw keeps bodies', async () => {
  for (const [tool, args, path, make, bad] of cases) for (const [field, value] of bad) {
    const body = make();
    if (field.startsWith('output.0.')) body.output = [{ type: 'function_call', name: 'f', call_id: 'c', arguments: '{}' }];
    if (field.startsWith('message.tool_calls.0.')) body.message.tool_calls = [{ function: { name: 'f', arguments: '{}' } }];
    if (field === 'model_info.x.context_length') body.model_info['x.context_length'] = value;
    else set(body, field, value);
    const f = await fixture(call => ({ body: call.path === path ? body : call.path === '/v1/models' ? { data: [{ id: 'm' }] } : { models: [] } }));
    try {
      const normal = await callTool(tool, args, f.ctx);
      assert.equal(normal.structuredContent.kind, 'unexpected_response', `${tool} ${field}`);
      const raw = await callTool(tool, { ...args, raw: true }, f.ctx);
      assert.equal(raw.isError, undefined, `${tool} ${field} raw`);
      if (tool === 'pico_list_models') assert.deepEqual(raw.structuredContent[path === '/v1/models' ? 'v1_models' : path === '/api/tags' ? 'api_tags' : 'api_show'].body ?? raw.structuredContent.api_show.m.body, body);
      else assert.deepEqual(raw.structuredContent.body, body);
    } finally { await f.close(); }
  }
});
test('Responses content parts require a string type and raw keeps bodies', async () => {
  const body = { ...responses(), output: [{ type: 'message', content: [{ text: 'ok' }] }] };
  const f = await fixture(() => ({ body }));
  try {
    const normal = await callTool('pico_responses', { input: 'hi' }, f.ctx);
    assert.equal(normal.structuredContent.kind, 'unexpected_response');
    const raw = await callTool('pico_responses', { input: 'hi', raw: true }, f.ctx);
    assert.equal(raw.isError, undefined);
    assert.deepEqual(raw.structuredContent.body, body);
  } finally { await f.close(); }
});
test('Responses reasoning parts require string text', async () => {
  for (const type of ['summary_text', 'reasoning_text']) for (const text of [undefined, null, 3]) {
    const part = { type, ...(text === undefined ? {} : { text }) };
    const body = { ...responses(), output: [{ type: 'reasoning', [type === 'summary_text' ? 'summary' : 'content']: [part] }] };
    const f = await fixture(() => ({ body }));
    try {
      assert.equal((await callTool('pico_responses', { input: 'hi' }, f.ctx)).structuredContent.kind, 'unexpected_response');
      assert.deepEqual((await callTool('pico_responses', { input: 'hi', raw: true }, f.ctx)).structuredContent.body, body);
      assert.equal((await callTool('pico_compare_models', { api: 'responses', models: ['a', 'b'], prompt: 'hi' }, f.ctx)).structuredContent.results[0].error.kind, 'unexpected_response');
    } finally { await f.close(); }
  }
});
test('comparison rows use the generation type checks', async () => {
  for (const [api, path, body] of [['chat_completions', '/v1/chat/completions', { ...chat(), created: 'bad' }], ['responses', '/v1/responses', { ...responses(), usage: { input_tokens: 'bad' } }], ['ollama', '/api/chat', { ...ollama(), done: 'bad' }]]) {
    const f = await fixture(() => ({ body }));
    try {
      const args = { api, models: ['m', 'n'], prompt: 'hi' };
      assert.equal((await callTool('pico_compare_models', args, f.ctx)).structuredContent.results[0].error.kind, 'unexpected_response', path);
      assert.deepEqual((await callTool('pico_compare_models', { ...args, raw: true }, f.ctx)).structuredContent.results[0].body, body);
    } finally { await f.close(); }
  }
});

test('tool call arguments with non-finite JSON remain strings', async () => {
  const argumentsText = '{"limits":{"maximum":1e309}}';
  const bodies = [
    ['pico_responses', { input: 'hi' }, { ...responses(), output: [{ type: 'function_call', name: 'f', call_id: 'c', arguments: argumentsText }] }, 'function_calls'],
    ['pico_chat_completions', { prompt: 'hi' }, { ...chat(), choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: argumentsText } }] } }] }, 'tool_calls']
  ];
  for (const [tool, args, body, key] of bodies) {
    const f = await fixture(() => ({ body }));
    try {
      const value = (await callTool(tool, args, f.ctx)).structuredContent[key][0].arguments;
      assert.equal(value, argumentsText);
    } finally { await f.close(); }
  }
});
