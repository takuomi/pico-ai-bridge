import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../server/core/registry.js';
import { fixture } from './fixtures.js';
import { generations } from './fixtures-pico.js';
test('pico_responses raw, extraction, and extra', async () => {
  const body = { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '<think>why</think>yes' }] }] };
  const f = await fixture(() => ({ body }));
  try {
    const args = { input: 'hello', extra: { custom: 1 } };
    const normal = await callTool('pico_responses', args, f.ctx);
    const raw = await callTool('pico_responses', { ...args, raw: true }, f.ctx);
    assert.equal(normal.structuredContent.answer, 'yes');
    assert.equal(normal.structuredContent.reasoning, 'why');
    assert.deepEqual(raw.structuredContent, { status: 200, body });
    assert.equal(f.calls[0].path, '/v1/responses');
    assert.equal('model' in f.calls[0].body, false);
    assert.equal(f.calls[0].body.custom, 1);
  } finally { await f.close(); }
});
test('responses omit absent input with or without instructions', async () => {
  const body = { error: { message: 'Coding key `input` not found.', code: 'invalid_request_error', type: 'api_error' } };
  const f = await fixture(() => ({ status: 400, body }));
  try {
    for (const args of [{}, { instructions: 'Reply with OK.' }]) {
      assert.deepEqual((await callTool('pico_responses', args, f.ctx)).structuredContent, { source: 'pico', status: 400, body });
      assert.deepEqual((await callTool('pico_responses', { ...args, raw: true }, f.ctx)).structuredContent, { source: 'pico', status: 400, body });
    }
    for (const call of f.calls) assert.equal(Object.hasOwn(call.body, 'input'), false);
    assert.equal(f.calls[2].body.instructions, 'Reply with OK.');
  } finally { await f.close(); }
});
test('responses joins refusal parts in output order beside text', async () => {
  const body = { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'secret ' }, { type: 'output_text', text: 'partial' }] }, { type: 'reasoning', content: [{ type: 'refusal', refusal: 'ignored' }] }, { type: 'message', content: [{ type: 'refusal', refusal: 'reason' }] }] };
  const f = await fixture(() => ({ body }));
  try {
    const result = await callTool('pico_responses', { input: 'hi' }, { ...f.ctx, config: { ...f.config, apiKey: 'secret' } });
    assert.equal(result.structuredContent.answer, 'partial');
    assert.equal(result.structuredContent.refusal, '[Redacted] reason');
  } finally { await f.close(); }
});
test('responses sends reasoning effort as reasoning.effort', async () => {
  const f = await fixture(() => ({ body: { output: [] } }));
  try {
    await callTool('pico_responses', { input: 'hi', reasoning_effort: 'xhigh', max_output_tokens: 0 }, f.ctx);
    assert.deepEqual(f.calls[0].body.reasoning, { effort: 'xhigh' });
    assert.equal('reasoning_effort' in f.calls[0].body, false);
    assert.equal(f.calls[0].body.max_output_tokens, 0);
    await callTool('pico_responses', { input: 'hi', reasoning_effort: 'custom-effort' }, f.ctx);
    assert.deepEqual(f.calls[1].body.reasoning, { effort: 'custom-effort' });
  } finally { await f.close(); }
});
test('responses sends json_schema with name and without strict', async () => {
  const f = await fixture(() => ({ body: { output: [] } }));
  try {
    await callTool('pico_responses', { input: 'hi', json_schema: { type: 'object' }, json_schema_name: 'answer' }, f.ctx);
    assert.deepEqual(f.calls[0].body.text, { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } });
  } finally { await f.close(); }
});
test('responses requires json_schema and json_schema_name together before image reads or requests', async () => {
  const f = await fixture(() => ({ body: { output: [] } }));
  try {
    for (const [args, message] of [
      [{ json_schema: { type: 'object' } }, 'json_schema_name is required with json_schema.'],
      [{ json_schema_name: 'answer' }, 'json_schema is required with json_schema_name.']
    ]) {
      const response = await callTool('pico_responses', { ...args, images: ['/missing/schema-test.png'] }, f.ctx);
      assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'invalid_arguments', message });
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});
test('synthetic response error fields redact Pico keys and values', async () => {
  const f = await fixture(() => ({ body: { output: [], usage: { input_tokens_details: { cached_tokens: 3 } }, error: { secret: 'secret' }, incomplete_details: { reason: 'secret' } } }));
  try {
    const response = await callTool('pico_responses', { input: 'hi' }, { ...f.ctx, config: { ...f.config, apiKey: 'secret' } });
    assert.equal(response.structuredContent.usage.cached_tokens, 3);
    assert.deepEqual(response.structuredContent.error, { '[Redacted]': '[Redacted]' });
    assert.deepEqual(response.structuredContent.incomplete_details, { reason: '[Redacted]' });
  } finally { await f.close(); }
});
test('pico_responses passes tools unchanged', async () => {
  const f = await fixture(() => ({ body: { id: 'r', status: 'completed', output: [] } }));
  const tools = [
    { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' }, strict: true, custom_field: 1 },
    { type: 'custom_kind', name: 'x' }
  ];
  try {
    await callTool('pico_responses', { input: 'hi', tools }, f.ctx);
    assert.deepEqual(f.calls[0].body.tools, tools);
  } finally { await f.close(); }
});
test('responses checks 2xx shape only in default mode', async () => {
  for (const body of [{}, null, { output: [{ content: [] }] }, { output: [{ type: 'message', content: {} }] }, { output: [{ type: 'reasoning', summary: [null] }] }, { output: [{ type: 'message', content: [{ type: 'output_text', text: {} }] }] }, { output: [{ type: 'reasoning', summary: [{ text: 1 }] }] },
    ...[{ name: 1 }, { call_id: 1 }, { name: undefined }, { call_id: undefined }].map(change => ({ ...generations.responsesFunctionCall.response, output: [{ ...generations.responsesFunctionCall.response.output[0], ...change }] }))]) {
    const f = await fixture(() => ({ body }));
    try {
      const normal = await callTool('pico_responses', { input: 'hi' }, f.ctx);
      assert.deepEqual(normal.structuredContent, { source: 'bridge', kind: 'unexpected_response', message: 'Pico /v1/responses returned a 2xx body that is not a response.' });
      assert.equal(normal.isError, true);
      assert.deepEqual((await callTool('pico_responses', { input: 'hi', raw: true }, f.ctx)).structuredContent, { status: 200, body: JSON.parse(JSON.stringify(body)) });
    } finally { await f.close(); }
  }
  const f = await fixture(() => ({ body: { output: [] } }));
  try { assert.equal((await callTool('pico_responses', { input: 'hi' }, f.ctx)).structuredContent.answer, ''); }
  finally { await f.close(); }
});
test('responses rejects malformed captured function calls and output text', async () => {
  const captured = generations.responsesFunctionCall.response;
  const original = captured.output[0];
  for (const [field, value] of [['name', null], ['call_id', null], ['arguments', undefined], ['arguments', {}], ['arguments', null]]) {
    const body = { ...captured, output: [{ ...original, [field]: value }] };
    const f = await fixture(() => ({ body }));
    try {
      assert.equal((await callTool('pico_responses', { input: 'hi' }, f.ctx)).structuredContent.kind, 'unexpected_response');
      assert.deepEqual((await callTool('pico_responses', { input: 'hi', raw: true }, f.ctx)).structuredContent.body, JSON.parse(JSON.stringify(body)));
    } finally { await f.close(); }
  }
  for (const part of [{ type: 'output_text' }, { type: 'output_text', text: null }, { type: 'output_text', text: 1 }, { type: 'refusal' }, { type: 'refusal', refusal: null }, { type: 'refusal', refusal: 1 }]) {
    const body = { output: [{ type: 'message', content: [part] }] };
    const f = await fixture(() => ({ body }));
    try { assert.equal((await callTool('pico_responses', { input: 'hi' }, f.ctx)).structuredContent.kind, 'unexpected_response'); }
    finally { await f.close(); }
  }
});
test('synthetic Responses custom call extracts and redacts free-text input', async () => {
  const body = { output: [{ type: 'custom_tool_call', id: 'item_1', call_id: 'call_1', name: 'run_code', input: 'print("secret")', status: 'completed' }, { type: 'custom_tool_call', id: null, call_id: 'call_2', name: 'run_code', input: 'print(2)', status: null }] };
  const f = await fixture(() => ({ body }));
  try {
    const ctx = { ...f.ctx, config: { ...f.config, apiKey: 'secret' } };
    const normal = await callTool('pico_responses', { input: 'hi' }, ctx);
    assert.deepEqual(normal.structuredContent.custom_tool_calls, [{ id: 'item_1', call_id: 'call_1', name: 'run_code', input: 'print("[Redacted]")', status: 'completed' }, { id: null, call_id: 'call_2', name: 'run_code', input: 'print(2)', status: null }]);
    assert.deepEqual(normal.structuredContent.function_calls, []);
    assert.deepEqual((await callTool('pico_responses', { input: 'hi', raw: true }, f.ctx)).structuredContent.body, body);
  } finally { await f.close(); }
});
test('synthetic Responses custom call rejects malformed fields', async () => {
  const item = { type: 'custom_tool_call', call_id: 'call_1', name: 'run_code', input: 'print(1)' };
  for (const change of [{ name: undefined }, { call_id: 1 }, { input: undefined }, { input: {} }, { id: 1 }, { status: 1 }]) {
    const f = await fixture(() => ({ body: { output: [{ ...item, ...change }] } }));
    try { assert.equal((await callTool('pico_responses', { input: 'hi' }, f.ctx)).structuredContent.kind, 'unexpected_response'); }
    finally { await f.close(); }
  }
});
