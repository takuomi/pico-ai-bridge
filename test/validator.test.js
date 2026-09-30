import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../server/core/validate.js';
import { callTool, createContext, publicTools } from '../server/core/registry.js';
import { readConfig } from '../server/core/config.js';
test('validation and registry', async () => {
  assert.equal(publicTools().length, 6);
  assert.equal(validate({ type: 'object', properties: { n: { type: 'integer', minimum: 2 } }, required: ['n'], additionalProperties: false }, { n: 1, x: 1 }).length, 2);
  const ctx = createContext(readConfig({ PICO_BASE_URL: 'http://127.0.0.1:1' }));
  assert.deepEqual((await callTool('pico_responses', { input: 42 }, ctx)).structuredContent.source, 'bridge');
  assert.equal((await callTool('pico_responses', { input: 42 }, ctx)).structuredContent.kind, 'invalid_arguments');
  assert.equal((await callTool('unknown', {}, ctx)).structuredContent.kind, 'unknown_tool');
});
test('number and integer validation rejects nonfinite and unsafe values', () => {
  assert.deepEqual(validate({ type: 'number' }, Infinity), ['arguments must be a finite number']);
  assert.deepEqual(validate({ type: 'integer' }, 2 ** 53), ['arguments must be a safe integer']);
  assert.deepEqual(validate({ type: 'number' }, 1.5), []);
  assert.deepEqual(validate({ type: 'integer' }, Number.MAX_SAFE_INTEGER), []);
});
test('null validation applies only to schemas that allow it', () => {
  assert.deepEqual(validate({ type: 'null' }, null), []);
  assert.deepEqual(validate({ type: 'null' }, false), ['arguments must be null']);
  assert.deepEqual(validate({ type: 'string' }, null), ['arguments must be string']);
  assert.deepEqual(validate(publicTools().find(tool => tool.name === 'pico_responses').inputSchema.properties.reasoning_effort, null), ['arguments must be string']);
});
test('think is boolean-only and other unions use type arrays so clients can convert values', () => {
  const schema = name => publicTools().find(tool => tool.name === name).inputSchema.properties;
  for (const [tool, key, types] of [
    ['pico_ollama_chat', 'think', 'boolean'], ['pico_compare_models', 'think', 'boolean'],
    ['pico_ollama_chat', 'format', ['string', 'object']], ['pico_ollama_chat', 'keep_alive', ['string', 'number']],
    ['pico_responses', 'input', ['string', 'array']], ['pico_responses', 'tool_choice', ['string', 'object']], ['pico_chat_completions', 'tool_choice', ['string', 'object']]
  ]) assert.deepEqual(schema(tool)[key].type, types, `${tool} ${key}`);
  for (const tool of publicTools()) for (const property of Object.values(tool.inputSchema.properties)) assert.ok(property.type, tool.name);
  for (const name of ['pico_ollama_chat', 'pico_compare_models']) {
    const think = schema(name).think;
    for (const value of [true, false]) assert.deepEqual(validate(think, value), []);
    for (const value of ['true', 'low', null]) assert.deepEqual(validate(think, value), ['arguments must be boolean']);
  }
  assert.deepEqual(validate(schema('pico_ollama_chat').format, 1), ['arguments must be string or object']);
  const input = schema('pico_responses').input;
  for (const value of ['hi', [], [{ role: 'user', content: 'hi' }]]) assert.deepEqual(validate(input, value), []);
  assert.deepEqual(validate(input, {}), ['arguments must be string or array']);
  assert.deepEqual(validate(input, ['hi']), ['arguments[0] must be object']);
  assert.deepEqual(validate(schema('pico_ollama_chat').keep_alive, Infinity), ['arguments must be string or a finite number']);
});
test('unexpected tool handler errors are internal errors with redacted stacks', async () => {
  const config = { ...readConfig({ PICO_BASE_URL: 'http://127.0.0.1:1', PICO_API_KEY: 'secret-value' }) };
  const ctx = { config, request: async () => { throw new Error('handler failed with secret-value'); } };
  const logged = [];
  const original = console.error;
  console.error = message => logged.push(message);
  try {
    const r = await callTool('pico_server_info', {}, ctx);
    assert.deepEqual(r.structuredContent, { source: 'bridge', kind: 'internal_error', message: 'handler failed with [Redacted]' });
    assert.match(logged.join('\n'), /Error: handler failed with \[Redacted\]/);
    assert.doesNotMatch(logged.join('\n'), /secret-value/);
  } finally { console.error = original; }
  assert.equal((await callTool('pico_responses', { input: 42 }, ctx)).structuredContent.kind, 'invalid_arguments');
});

test('inherited property names are unknown keys', () => {
  for (const key of ['toString', 'constructor', '__proto__']) {
    const value = JSON.parse(`{"${key}":{}}`);
    assert.deepEqual(validate({ type: 'object', properties: {}, additionalProperties: false }, value), [`arguments.${key} is not allowed`]);
  }
});

test('inherited required keys are reported missing', () => {
  const value = Object.create({ required: 'inherited' });
  assert.deepEqual(validate({ type: 'object', properties: { required: { type: 'string' } }, required: ['required'] }, value), ['arguments.required is required']);
});

test('overflowing numbers anywhere in free-form arguments are rejected before any request', async () => {
  let requests = 0;
  const ctx = { config: readConfig({ PICO_BASE_URL: 'http://127.0.0.1:1' }), request: async () => { requests++; return { status: 200, body: {} }; } };
  const parsed = JSON.parse('{"prompt":"hi","extra":{"top_k":1e309},"tools":[{"type":"function","function":{"name":"f","parameters":{"maximum":-1e309}}}]}');
  const response = await callTool('pico_chat_completions', parsed, ctx);
  assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'invalid_arguments', message: 'arguments.extra.top_k must be a finite number; arguments.tools[0].function.parameters.maximum must be a finite number' });
  const messages = await callTool('pico_ollama_chat', JSON.parse('{"messages":[{"role":"user","content":"hi","n":1e400}]}'), ctx);
  assert.equal(messages.structuredContent.message, 'arguments.messages[0].n must be a finite number');
  assert.equal(requests, 0);
});

test('unsafe integers in nested arguments are rejected at the safe boundary', async () => {
  let requests = 0;
  const ctx = { config: readConfig({ PICO_BASE_URL: 'http://127.0.0.1:1' }), request: async () => { requests++; return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } }; } };
  const accepted = await callTool('pico_chat_completions', { prompt: 'hi', extra: { nested: [Number.MAX_SAFE_INTEGER, 1.5] } }, ctx);
  assert.equal(accepted.isError, undefined);
  const rejected = await callTool('pico_chat_completions', JSON.parse('{"prompt":"hi","extra":{"nested":[9007199254740993]},"tools":[{"limit":-9007199254740993}]}'), ctx);
  assert.deepEqual(rejected.structuredContent, { source: 'bridge', kind: 'invalid_arguments', message: 'arguments.extra.nested[0] must be a safe integer or a non-integral number; arguments.tools[0].limit must be a safe integer or a non-integral number' });
  assert.equal(requests, 1);
});
