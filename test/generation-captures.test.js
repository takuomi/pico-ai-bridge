import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../server/core/registry.js';
import { fixture } from './fixtures.js';
import { generations } from './fixtures-pico.js';

const names = { chat: 'pico_chat_completions', responses: 'pico_responses', ollama: 'pico_ollama_chat' };
const paths = { chat: '/v1/chat/completions', responses: '/v1/responses', ollama: '/api/chat' };
test('chat and Ollama accept system alone without a user message', async () => {
  for (const [style, body] of [['chat', generations.chatPlainQwen.response], ['ollama', generations.ollamaPlain.response]]) {
    const missingBody = { error: 'Coding key `messages` not found.' };
    const f = await fixture(call => style === 'ollama' && !Object.hasOwn(call.body, 'messages') ? { status: 400, body: missingBody } : { body });
    try {
      const result = await callTool(names[style], { system: 'rules' }, f.ctx);
      assert.equal(result.isError, undefined);
      assert.deepEqual(f.calls[0].body.messages, [{ role: 'system', content: 'rules' }]);
      const missing = await callTool(names[style], {}, f.ctx);
      if (style === 'chat') assert.equal(missing.structuredContent.message, 'Provide prompt, messages, images or system.');
      else {
        assert.deepEqual(missing.structuredContent, { source: 'pico', status: 400, body: missingBody });
        assert.equal(Object.hasOwn(f.calls[1].body, 'messages'), false);
      }
      const comparison = await callTool('pico_compare_models', { models: ['a', 'b'], system: 'rules' }, f.ctx);
      assert.equal(comparison.structuredContent.message, 'Provide prompt, messages or images.');
      assert.equal(f.calls.length, style === 'chat' ? 1 : 2);
    } finally { await f.close(); }
  }
});
const responseUsage = usage => ({ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, reasoning_tokens: usage.output_tokens_details.reasoning_tokens,
  cached_tokens: usage.input_tokens_details.cached_tokens, total_tokens: usage.total_tokens, prompt_time_ms: usage.prompt_time_ms, generation_time_ms: usage.generation_time_ms });
const capturedExpected = {
  chatPlainQwen: { answer: 'The sky on a clear day is usually blue.', refusal: null, reasoning: '', finish_reason: 'stop', response_id: 'chatcmpl-18359', response_model: 'Qwen3-VL-2B-Instruct-4bit', created: 1790536419, usage: null, tool_calls: [] },
  chatToolCallQwen: { answer: '', refusal: null, reasoning: '', finish_reason: 'tool_calls', response_id: 'chatcmpl-20343', response_model: 'Qwen3-VL-2B-Instruct-4bit', created: 1790536428, usage: null,
    tool_calls: [{ id: 'call_8B55201B-51D0-442F-A86C-C4A16458EF11', type: 'function', name: 'get_weather', arguments: { city: 'Tokyo' } }] },
  responsesPlain: { answer: 'The sky appears blue on a clear day.', refusal: null, reasoning: '', response_id: 'resp_9c919ab02052404fb2240eb869f59946', response_model: 'gpt-oss-20b-MXFP4-Q8', status: 'completed', created_at: generations.responsesPlain.response.created_at ?? null, completed_at: generations.responsesPlain.response.completed_at ?? null,
    usage: responseUsage(generations.responsesPlain.response.usage), error: null, incomplete_details: null, function_calls: [], custom_tool_calls: [] },
  responsesFunctionCall: { answer: '', refusal: null, reasoning: '', response_id: 'resp_35ae5d7eb1014d7db778bcc15e2f8e93', response_model: 'gpt-oss-20b-MXFP4-Q8', status: 'completed', created_at: generations.responsesFunctionCall.response.created_at ?? null, completed_at: generations.responsesFunctionCall.response.completed_at ?? null,
    usage: responseUsage(generations.responsesFunctionCall.response.usage), error: null, incomplete_details: null,
    function_calls: [{ id: 'fc_74598b30dda641da97b438483f924309', call_id: 'call_783317E0-F8B1-45F3-9757-0DE6D7A183D3', name: 'get_weather', arguments: { city: 'Tokyo' }, status: 'completed' }], custom_tool_calls: [] },
  ollamaPlain: { answer: 'The sky is blue on a clear day.', reasoning: '', usage: { prompt_eval_count: null, eval_count: null }, durations_ms: { total: 11329, load: 5645, prompt_eval: null, eval: null },
    finish_reason: null, response_model: 'gpt-oss-20b-MXFP4-Q8', created_at: '2026-09-27T19:07:57Z', done: true, tool_calls: [] },
  ollamaToolCall: { answer: '', reasoning: '', usage: { prompt_eval_count: null, eval_count: null }, durations_ms: { total: 3517, load: 1653, prompt_eval: null, eval: null },
    finish_reason: null, response_model: 'gpt-oss-20b-MXFP4-Q8', created_at: '2026-09-27T19:08:28Z', done: true, tool_calls: [{ id: null, name: 'get_weather', arguments: { city: 'Tokyo' } }] }
};
test('captured plain and tool-call responses normalize complete structured content', async () => {
  for (const [style, plain, called] of [
    ['chat', 'chatPlainQwen', 'chatToolCallQwen'], ['responses', 'responsesPlain', 'responsesFunctionCall'], ['ollama', 'ollamaPlain', 'ollamaToolCall']
  ]) {
    const f = await fixture(call => ({ body: call.body.tools ? generations[called].response : generations[plain].response }));
    try {
      const request = generations[plain].request;
      const args = style === 'responses' ? { model: request.model, input: request.input } : { model: request.model, messages: request.messages };
      const normal = await callTool(names[style], args, f.ctx);
      assert.equal(normal.isError, undefined);
      assert.deepEqual(normal.structuredContent, capturedExpected[plain]);
      if (style === 'ollama') {
        assert.equal(normal.structuredContent.finish_reason, null);
        assert.deepEqual(normal.structuredContent.usage, { prompt_eval_count: null, eval_count: null });
      }
      assert.deepEqual(f.calls[0].body, request);
      const tool = generations[called].request;
      const field = style === 'responses' ? 'input' : 'messages';
      const toolArgs = { model: tool.model, [field]: tool[field], tools: tool.tools, ...(tool.tool_choice ? { tool_choice: tool.tool_choice } : {}) };
      const result = await callTool(names[style], toolArgs, f.ctx);
      assert.equal(result.isError, undefined);
      assert.deepEqual(f.calls[1].body, tool);
      assert.deepEqual(result.structuredContent, capturedExpected[called]);
      if (style === 'ollama') {
        assert.equal(result.structuredContent.finish_reason, null);
        assert.deepEqual(result.structuredContent.usage, { prompt_eval_count: null, eval_count: null });
      }
    } finally { await f.close(); }
  }
});
test('captured tool-result follow-ups pass input items unchanged', async () => {
  for (const [style, key] of [['chat', 'chatToolResult'], ['responses', 'responsesToolResult'], ['ollama', 'ollamaToolResult']]) {
    const captured = generations[key];
    const f = await fixture(() => ({ body: captured.response }));
    try {
      const field = style === 'responses' ? 'input' : 'messages';
      const result = await callTool(names[style], { model: captured.request.model, [field]: captured.request[field], tools: captured.request.tools }, f.ctx);
      assert.equal(result.isError, undefined);
      assert.deepEqual(f.calls[0].body, captured.request);
      assert.equal(f.calls[0].path, paths[style]);
    } finally { await f.close(); }
  }
});
test('chat null content, tool IDs and response format pass unchanged', async () => {
  const body = generations.chatToolCall.response;
  const f = await fixture(() => ({ body }));
  try {
    const messages = [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: '{}' }];
    const format = { type: 'json_object', custom: 1 };
    const result = await callTool(names.chat, { messages, response_format: format }, f.ctx);
    assert.deepEqual(f.calls[0].body.messages, messages);
    assert.deepEqual(f.calls[0].body.response_format, format);
    assert.deepEqual(result.structuredContent.tool_calls[0], { id: body.choices[0].message.tool_calls[0].id, type: 'function', name: 'get_weather', arguments: { city: 'Tokyo' } });
    const conflict = await callTool(names.chat, { messages, response_format: format, extra: { response_format: {} } }, f.ctx);
    assert.equal(conflict.structuredContent.message, 'extra conflicts with response_format (use response_format).');
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});
test('responses string and function items pass unchanged; stream is fixed', async () => {
  const body = generations.responsesFunctionCall.response;
  const f = await fixture(() => ({ body }));
  try {
    await callTool(names.responses, { input: 'hello' }, f.ctx);
    assert.equal(f.calls[0].body.input, 'hello');
    assert.equal(f.calls[0].body.stream, false);
    const input = generations.responsesToolResult.request.input;
    const result = await callTool(names.responses, { input }, f.ctx);
    assert.deepEqual(f.calls[1].body.input, input);
    const item = body.output.find(x => x.type === 'function_call');
    assert.deepEqual(result.structuredContent.function_calls[0], { id: item.id, call_id: item.call_id, name: item.name, arguments: { city: 'Tokyo' }, status: item.status });
    const conflict = await callTool(names.responses, { input, extra: { stream: true } }, f.ctx);
    assert.equal(conflict.structuredContent.message, 'extra conflicts with stream (stream is fixed to false).');
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});
test('responses omits absent input and has no messages argument', async () => {
  const body = { error: { message: 'Coding key `input` not found.', code: 'invalid_request_error', type: 'api_error' } };
  const f = await fixture(() => ({ status: 400, body }));
  try {
    const missing = await callTool(names.responses, {}, f.ctx);
    assert.deepEqual(missing.structuredContent, { source: 'pico', status: 400, body });
    assert.equal(Object.hasOwn(f.calls[0].body, 'input'), false);
    assert.deepEqual((await callTool(names.responses, { raw: true }, f.ctx)).structuredContent, { source: 'pico', status: 400, body });
    assert.equal(Object.hasOwn(f.calls[1].body, 'input'), false);
    const old = await callTool(names.responses, { messages: [{ role: 'user', content: 'hi' }] }, f.ctx);
    assert.equal(old.structuredContent.kind, 'invalid_arguments');
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});
test('images append to the last user array without mutating caller data', async () => {
  for (const style of ['chat', 'responses', 'ollama']) {
    const response = generations[style === 'responses' ? 'responsesPlain' : style === 'ollama' ? 'ollamaPlain' : 'chatPlain'].response;
    const f = await fixture(() => ({ body: response }));
    try {
      const content = style === 'ollama' ? 'look' : [{ type: style === 'responses' ? 'input_text' : 'text', text: 'look' }];
      const user = { role: 'user', content, ...(style === 'ollama' ? { images: ['old'] } : {}) };
      const field = style === 'responses' ? 'input' : 'messages';
      const source = [user, { role: 'assistant', content: 'later' }];
      await callTool(names[style], { [field]: source, images: ['DATA:image/png;base64,YWJj'] }, f.ctx);
      const sent = f.calls[0].body[field][0];
      assert.deepEqual(content, style === 'ollama' ? 'look' : [{ type: style === 'responses' ? 'input_text' : 'text', text: 'look' }]);
      assert.deepEqual(user.images, style === 'ollama' ? ['old'] : undefined);
      if (style === 'ollama') assert.deepEqual(sent.images, ['old', 'YWJj']);
      else assert.deepEqual(sent.content.slice(1), style === 'responses' ? [{ type: 'input_image', image_url: 'DATA:image/png;base64,YWJj' }] : [{ type: 'image_url', image_url: { url: 'DATA:image/png;base64,YWJj' } }]);
      assert.deepEqual(f.calls[0].body[field][1], source[1]);
    } finally { await f.close(); }
  }
});
test('image-only calls work and invalid user content fails before image reads', async () => {
  for (const style of ['chat', 'responses', 'ollama']) {
    const response = generations[style === 'responses' ? 'responsesPlain' : style === 'ollama' ? 'ollamaPlain' : 'chatPlain'].response;
    const f = await fixture(() => ({ body: response }));
    try {
      const field = style === 'responses' ? 'input' : 'messages';
      await callTool(names[style], { images: ['data:image/png;base64,YWJj'] }, f.ctx);
      const user = f.calls[0].body[field][0];
      assert.equal(user.role, 'user');
      if (style === 'ollama') { assert.equal(user.content, ''); assert.deepEqual(user.images, ['YWJj']); }
      else assert.equal(user.content.length, 1);
      await callTool(names[style], { [field]: [], images: ['data:image/png;base64,YWJj'] }, f.ctx);
      assert.deepEqual(f.calls[1].body[field], [user]);
      const bad = await callTool(names[style], { [field]: [{ role: 'user', content: null }], images: ['/missing/image.png'] }, f.ctx);
      assert.deepEqual(bad.structuredContent, { source: 'bridge', kind: 'invalid_arguments', message: 'Images require a user message with string or array content.' });
      const noUser = await callTool(names[style], { [field]: [{ role: 'assistant', content: 'hi' }], images: ['/missing/image.png'] }, f.ctx);
      assert.deepEqual(noUser.structuredContent, bad.structuredContent);
      if (style === 'responses') {
        await callTool(names.responses, { input: 'look', images: ['data:image/png;base64,YWJj'] }, f.ctx);
        assert.deepEqual(f.calls[2].body.input[0].content, [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,YWJj' }]);
      }
      assert.equal(f.calls.length, style === 'responses' ? 3 : 2);
    } finally { await f.close(); }
  }
});
test('comparison responses keep the prompt and send stream false', async () => {
  const f = await fixture(() => ({ body: generations.responsesPlain.response }));
  try {
    await callTool('pico_compare_models', { models: ['a', 'b'], prompt: 'hi', api: 'responses' }, f.ctx);
    assert.deepEqual(f.calls.map(call => ({ input: call.body.input, stream: call.body.stream })), [{ input: 'hi', stream: false }, { input: 'hi', stream: false }]);
  } finally { await f.close(); }
});
test('missing durations are null in Ollama structured and text results', async () => {
  const f = await fixture(() => ({ body: { model: 'm', message: { role: 'assistant', content: '' } } }));
  try {
    const result = await callTool(names.ollama, { prompt: '' }, f.ctx);
    assert.deepEqual(result.structuredContent.durations_ms, { total: null, load: null, prompt_eval: null, eval: null });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(result.structuredContent.response_model, 'm');
  } finally { await f.close(); }
});
test('captured API requests keep exact mapped fields', async () => {
  const formatError = { error: 'Type mismatch for `format` key, expected `String` type.' };
  const f = await fixture(call => call.path === '/api/chat' ? { status: 400, body: formatError } : { body: call.path === '/v1/responses' ? generations.responsesPlain.response : generations.chatPlain.response });
  try {
    const format = { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] };
    const ollama = await callTool(names.ollama, { prompt: 'What color is the sky on a clear day? Answer in one sentence.', format, keep_alive: '5m' }, f.ctx);
    assert.deepEqual(f.calls[0].body, { stream: false, messages: [{ role: 'user', content: 'What color is the sky on a clear day? Answer in one sentence.' }], format, keep_alive: '5m' });
    assert.equal(ollama.isError, true);
    assert.deepEqual(ollama.structuredContent, { source: 'pico', status: 400, body: formatError });
    await callTool(names.responses, { input: 'hi', previous_response_id: 'resp_1', json_schema: format, json_schema_name: 'answer' }, f.ctx);
    assert.deepEqual(f.calls[1].body, { stream: false, input: 'hi', previous_response_id: 'resp_1', text: { format: { type: 'json_schema', name: 'answer', schema: format } } });
    await callTool(names.chat, { prompt: 'hi', response_format: { type: 'json_object' } }, f.ctx);
    assert.deepEqual(f.calls[2].body, { stream: false, messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } });
  } finally { await f.close(); }
});
