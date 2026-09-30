import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import http from 'node:http';
import https from 'node:https';
import { readConfig } from '../server/core/config.js';
import { callTool, createContext } from '../server/core/registry.js';
import { redactPicoData } from '../server/core/util.js';

const hasAnswer = value => typeof value === 'string' && value.trim().length > 0;

function solidPng() {
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(8 * 25);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pixels[y * 25 + 1 + x * 3] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

test('live Pico API output shapes', { skip: !process.env.PICO_BASE_URL, timeout: 3600000 }, async t => {
  const ctx = createContext(readConfig({ ...process.env, PICO_TIMEOUT_MS: process.env.PICO_TIMEOUT_MS || '600000', PICO_MAX_CONCURRENT_REQUESTS: '1' }));
  const toolsModel = process.env.PICO_TEST_TOOLS_MODEL || 'Qwen3-VL-2B-Instruct-4bit';
  const visionModel = process.env.PICO_TEST_VISION_MODEL || 'Qwen3-VL-2B-Instruct-4bit';
  const thinkingModels = (process.env.PICO_TEST_THINKING_MODELS || 'LFM2.5-1.2B-Thinking-4bit').split(',').map(model => model.trim()).filter(Boolean);
  assert.ok(thinkingModels.length > 0, 'At least one thinking model is required.');
  const models = [...new Set([toolsModel, visionModel, ...thinkingModels])];
  assert.ok(models.length >= 2, 'Live generation requires at least two distinct role models.');
  const functionTool = { name: 'lookup_weather', description: 'Look up current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
  const prompt = 'What color is the sky on a clear day? Answer in one sentence.';
  const toolPrompt = 'You need current weather in Tokyo. Call lookup_weather with city Tokyo now. Do not guess or answer without calling the tool.';
  const outcomes = [];

  async function checked(name, args) {
    const response = await callTool(name, args, ctx);
    assert.equal(response?.isError, undefined, name + ': ' + JSON.stringify(response?.structuredContent));
    return response.structuredContent;
  }

  async function generation(name, model, invoke, validate) {
    let outcome = 'FAIL';
    try {
      const response = await invoke();
      assert.equal(response?.isError, undefined, name + ' (' + model + '): ' + JSON.stringify(response?.structuredContent));
      validate(response.structuredContent);
      outcome = 'PASS';
    } finally { outcomes.push({ name, model, outcome }); }
  }

  function startStdio() {
    const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PICO_TIMEOUT_MS: process.env.PICO_TIMEOUT_MS || '600000', PICO_MAX_CONCURRENT_REQUESTS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const readerDone = new Promise(resolve => reader.once('close', resolve));
    const lines = reader[Symbol.asyncIterator]();
    let callId = 0;
    async function replyFor(id) {
      for (;;) {
        const { value, done } = await lines.next();
        assert.ok(!done, 'No reply for ID ' + id + ': ' + stderr);
        const message = JSON.parse(value);
        if (message.id === id) return message;
      }
    }
    async function request(method, params) {
      const id = ++callId;
      send({ jsonrpc: '2.0', id, method, params });
      return replyFor(id);
    }
    async function close() {
      child.stdin.end();
      assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
      await readerDone;
    }
    return { send, request, close };
  }

  function validateGeneration(name, raw, data) {
    if (raw) {
      assert.equal(data?.status, 200, 'Invalid raw status: ' + JSON.stringify(data).slice(0, 2000));
      assert.ok(data.body && typeof data.body === 'object', 'Missing raw body: ' + JSON.stringify(data).slice(0, 2000));
      if (name === 'pico_responses') {
        assert.ok(Array.isArray(data.body.output), 'Missing raw output: ' + JSON.stringify(data).slice(0, 2000));
        assert.ok(typeof data.body.id === 'string', 'Missing raw id: ' + JSON.stringify(data).slice(0, 2000));
      } else if (name === 'pico_chat_completions') {
        assert.ok(Array.isArray(data.body.choices) && data.body.choices.length > 0, 'Missing raw choices: ' + JSON.stringify(data).slice(0, 2000));
        assert.ok(data.body.choices[0].message, 'Missing raw message: ' + JSON.stringify(data).slice(0, 2000));
      } else {
        assert.ok(data.body.message && typeof data.body.message.content === 'string', 'Missing raw Ollama message: ' + JSON.stringify(data).slice(0, 2000));
      }
    } else {
      assert.ok(data && typeof data === 'object');
      assert.equal(typeof data.answer, 'string');
      assert.ok(Array.isArray(data[name === 'pico_responses' ? 'function_calls' : 'tool_calls']));
      if (name === 'pico_responses') {
        assert.ok(data.response_id);
        assert.ok(data.usage && typeof data.usage === 'object');
      } else if (name === 'pico_chat_completions') {
        assert.ok('finish_reason' in data);
        assert.ok('usage' in data);
      } else {
        assert.ok(data.durations_ms && typeof data.durations_ms === 'object');
      }
    }
  }

  try {
    let listed;
    await t.test('GET tools default and raw', async () => {
      const info = await checked('pico_server_info', {});
      assert.ok(info.reachable && typeof info.version === 'string');
      const rawInfo = await checked('pico_server_info', { raw: true });
      assert.equal(rawInfo.status, 200);
      assert.equal(rawInfo.body.version, info.version);
      listed = await checked('pico_list_models', { include_capabilities: true });
      for (const model of models) {
        const matches = listed.models.filter(x => x.id === model);
        assert.equal(matches.length, 1, 'Expected one model: ' + model);
        const item = matches[0];
        assert.equal(item.name, model + ':latest');
        assert.equal(typeof item.tag_model, 'string');
        assert.ok(item.display_name === null || typeof item.display_name === 'string');
        assert.equal(typeof item.status, 'string');
        assert.ok(item.created === null || Number.isInteger(item.created));
        assert.ok(item.owned_by === null || typeof item.owned_by === 'string');
        assert.ok(Array.isArray(item.capabilities), 'Missing capabilities for ' + model + ': ' + JSON.stringify(item));
      }
      assert.ok(Array.isArray(listed.partial_errors));
      for (const item of listed.partial_errors) {
        assert.equal(typeof item.path, 'string');
        assert.equal(item.error?.source, 'pico');
        assert.ok(Number.isInteger(item.error.status));
        assert.ok('body' in item.error);
      }
      for (const item of listed.models.filter(item => item.capabilities_error)) {
        assert.equal(item.capabilities_error.source, 'pico');
        assert.ok(Number.isInteger(item.capabilities_error.status));
        assert.ok('body' in item.capabilities_error);
      }
      const listedIds = new Set(listed.models.filter(item => typeof item.id === 'string').map(item => /:[^/]*$/.test(item.id) ? item.id : item.id + ':latest'));
      assert.ok(listed.models.every(item => item.id !== null || typeof item.name !== 'string' || !listedIds.has(/:[^/]*$/.test(item.name) ? item.name : item.name + ':latest')));
      const rawList = await checked('pico_list_models', { raw: true, include_capabilities: true });
      assert.equal(rawList.v1_models.status, 200);
      assert.equal(rawList.api_tags.status, 200);
      for (const model of models) assert.equal(rawList.api_show[model + ':latest']?.status, 200);
    });

    await t.test('shipped stdio server runs every tool live', async () => {
      const stdio = startStdio();
      async function stdioCall(name, args) {
        const reply = await stdio.request('tools/call', { name, arguments: args });
        assert.ok(reply.result, name + ': ' + JSON.stringify(reply));
        return reply.result;
      }
      try {
        assert.ok((await stdio.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live-test', version: '1' } })).result, 'Stdio initialize failed');
        stdio.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await generation('stdio pico_server_info', '-', () => stdioCall('pico_server_info', {}), data => {
          assert.equal(data.reachable, true);
          assert.equal(typeof data.version, 'string');
        });
        await generation('stdio pico_list_models', '-', () => stdioCall('pico_list_models', {}), data => {
          assert.ok(Array.isArray(data.models) && data.models.length > 0, 'Missing models: ' + JSON.stringify(data));
          for (const model of models) assert.equal(data.models.filter(item => item.id === model).length, 1, 'Expected one model: ' + model);
        });
        for (const [name, args] of [
          ['pico_chat_completions', { prompt, max_tokens: 4096, temperature: 0 }],
          ['pico_responses', { input: prompt, max_output_tokens: 4096, temperature: 0 }],
          ['pico_ollama_chat', { prompt, options: { num_predict: 4096, temperature: 0 } }]
        ]) await generation('stdio ' + name, toolsModel, () => stdioCall(name, { model: toolsModel, ...args }), data => {
          validateGeneration(name, false, data);
          assert.ok(hasAnswer(data.answer), name + ': missing answer: ' + JSON.stringify(data));
          assert.equal(data.response_model, toolsModel);
        });
        for (const [name, args] of [
          ['pico_chat_completions', { prompt, max_tokens: 4096, temperature: 0 }],
          ['pico_responses', { input: prompt, max_output_tokens: 4096, temperature: 0 }],
          ['pico_ollama_chat', { prompt, options: { num_predict: 4096, temperature: 0 } }]
        ]) await generation('stdio raw ' + name, toolsModel, () => stdioCall(name, { model: toolsModel, ...args, raw: true }), data => validateGeneration(name, true, data));
        const compared = models.slice(0, 2);
        await generation('stdio pico_compare_models chat_completions', compared.join(', '),
          () => stdioCall('pico_compare_models', { models: compared, prompt, api: 'chat_completions', temperature: 0, max_tokens: 3072 }), data => {
            assert.equal(data.api, 'chat_completions');
            assert.equal(data?.results?.length, 2);
            for (const [index, row] of data.results.entries()) {
              assert.equal(row.model, compared[index]);
              assert.equal(row.error, undefined, row.model + ': ' + JSON.stringify(row.error));
              assert.ok(hasAnswer(row.answer), row.model + ': missing answer: ' + JSON.stringify(row));
              assert.equal(row.response_model, row.model);
            }
          });
      } finally {
        await stdio.close();
      }
    });

    await t.test('shipped stdio server runs modern generation live', async () => {
      const stdio = startStdio();
      const _meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
        'io.modelcontextprotocol/clientInfo': { name: 'live-modern', version: '1' } };
      try {
        const discover = await stdio.request('server/discover', { _meta });
        assert.equal(discover.result?.resultType, 'complete', JSON.stringify(discover));
        assert.deepEqual(discover.result.supportedVersions, ['2026-07-28']);
        const listed = await stdio.request('tools/list', { _meta });
        assert.equal(listed.result?.resultType, 'complete', JSON.stringify(listed));
        assert.equal(listed.result.tools?.length, 6);
        for (const [name, args] of [
          ['pico_chat_completions', { prompt, max_tokens: 4096, temperature: 0 }],
          ['pico_responses', { input: prompt, max_output_tokens: 4096, temperature: 0 }],
          ['pico_ollama_chat', { prompt, options: { num_predict: 4096, temperature: 0 } }]
        ]) await generation('stdio modern ' + name, toolsModel, async () => {
          const reply = await stdio.request('tools/call', { name, arguments: { model: toolsModel, ...args }, _meta });
          assert.equal(reply.result?.resultType, 'complete', name + ': ' + JSON.stringify(reply));
          return reply.result;
        }, data => {
          assert.ok(hasAnswer(data.answer), name + ': missing answer: ' + JSON.stringify(data));
          assert.equal(data.response_model, toolsModel);
        });
      } finally { await stdio.close(); }
    });

    // Temperature 0 keeps small thinking models from running away; the test checks bridge behaviour, not sampling.
    for (const model of models) {
      for (const raw of [false, true]) {
        const mode = raw ? 'raw' : 'default';
        for (const [name, args] of [
          ['pico_responses', { input: prompt, max_output_tokens: 4096, temperature: 0 }],
          ['pico_chat_completions', { prompt, max_tokens: 4096, temperature: 0 }],
          ['pico_ollama_chat', { prompt, options: { num_predict: 4096, temperature: 0 } }]
        ]) {
          await t.test(name + ' ' + mode + ' (' + model + ')', async () => {
            await generation(name + ' ' + mode, model, () => callTool(name, { model, ...args, raw }, ctx), data => {
              validateGeneration(name, raw, data);
              if (!raw) {
                assert.ok(hasAnswer(data.answer), name + ': missing answer: ' + JSON.stringify(data));
                assert.equal(data.response_model, model);
              }
            });
          });
        }
      }
    }

    for (const raw of [false, true]) {
      for (const [name, args, field] of [
        ['pico_responses', { input: toolPrompt, max_output_tokens: 1024, temperature: 0, tools: [{ type: 'function', ...functionTool }], tool_choice: 'auto' }, 'function_calls'],
        ['pico_chat_completions', { prompt: toolPrompt, max_tokens: 1024, temperature: 0, tools: [{ type: 'function', function: functionTool }], tool_choice: 'auto' }, 'tool_calls'],
        ['pico_ollama_chat', { prompt: toolPrompt, options: { temperature: 0, num_predict: 1024 }, tools: [{ type: 'function', function: functionTool }] }, 'tool_calls']
      ]) {
        await t.test(name + ' tool calls ' + (raw ? 'raw' : 'default') + ' (' + toolsModel + ')', async () => {
          await generation(name + ' tool calls ' + (raw ? 'raw' : 'default'), toolsModel, () => callTool(name, { model: toolsModel, ...args, raw }, ctx), data => {
            validateGeneration(name, raw, data);
            if (raw) {
              assert.equal(data?.status, 200);
              const calls = name === 'pico_responses' ? data.body?.output?.filter(x => x.type === 'function_call')
                : name === 'pico_ollama_chat' ? data.body?.message?.tool_calls : data.body?.choices?.[0]?.message?.tool_calls;
              assert.ok(Array.isArray(calls) && calls.length > 0, name + ': no tool calls: ' + JSON.stringify(data));
              assert.equal(name === 'pico_responses' ? calls[0].name : calls[0].function?.name, 'lookup_weather');
            } else {
              assert.ok(Array.isArray(data?.[field]) && data[field].length > 0, name + ': no tool calls: ' + JSON.stringify(data));
              assert.equal(data[field][0].name, 'lookup_weather');
            }
          });
        });
      }
    }

    const weatherResult = '{"city":"Tokyo","temperature_c":20,"condition":"sunny"}';
    const chatTools = [{ type: 'function', function: functionTool }];
    const responseTools = [{ type: 'function', ...functionTool }];
    for (const name of ['pico_chat_completions', 'pico_responses', 'pico_ollama_chat']) await t.test(name + ' tool result ' + (name === 'pico_responses' ? 'accepted' : 'round trip') + ' (' + toolsModel + ')', async () => {
      const firstArgs = name === 'pico_chat_completions' ? { prompt: toolPrompt, max_tokens: 1024, tools: chatTools }
        : name === 'pico_responses' ? { input: toolPrompt, max_output_tokens: 1024, tools: responseTools }
          : { prompt: toolPrompt, options: { num_predict: 1024 }, tools: chatTools };
      const first = await checked(name, { model: toolsModel, ...firstArgs });
      const calls = first[name === 'pico_responses' ? 'function_calls' : 'tool_calls'];
      assert.ok(Array.isArray(calls) && calls.length > 0, name + ': no initial tool call: ' + JSON.stringify(first));
      const call = calls[0];
      assert.equal(call.name, 'lookup_weather');
      assert.equal(call.arguments?.city, 'Tokyo');
      let follow;
      if (name === 'pico_chat_completions') {
        assert.equal(typeof call.id, 'string');
        follow = { messages: [{ role: 'user', content: toolPrompt }, { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, { role: 'tool', tool_call_id: call.id, content: weatherResult }], max_tokens: 1024, tools: chatTools };
      } else if (name === 'pico_responses') {
        assert.equal(typeof call.id, 'string');
        assert.equal(typeof call.call_id, 'string');
        follow = { input: [{ role: 'user', content: toolPrompt }, { type: 'function_call', id: call.id, call_id: call.call_id, name: call.name, arguments: JSON.stringify(call.arguments), status: call.status }, { type: 'function_call_output', call_id: call.call_id, output: weatherResult }], max_output_tokens: 1024, tools: responseTools };
      } else follow = { messages: [{ role: 'user', content: toolPrompt }, { role: 'assistant', content: '', tool_calls: [{ id: 'call_live_1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, { role: 'tool', tool_call_id: 'call_live_1', content: weatherResult }], options: { num_predict: 1024 }, tools: chatTools };
      await generation(name + ' tool result', toolsModel, () => callTool(name, { model: toolsModel, ...follow }, ctx), data => {
        const calls = data[name === 'pico_responses' ? 'function_calls' : 'tool_calls'];
        assert.ok(/20|sunny/i.test(data.answer) || calls?.some(call => call.name === 'lookup_weather' && call.arguments?.city === 'Tokyo'), 'Missing weather answer or function call: ' + JSON.stringify(data));
      });
    });

    const skySchema = { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] };
    for (const [label, name, args] of [
      ['chat json_schema', 'pico_chat_completions', { prompt, max_tokens: 1024, response_format: { type: 'json_schema', json_schema: { name: 'sky', schema: skySchema } } }],
      ['chat json_object', 'pico_chat_completions', { prompt, max_tokens: 1024, response_format: { type: 'json_object' } }],
      ['responses json_schema', 'pico_responses', { input: prompt, max_output_tokens: 1024, json_schema: skySchema, json_schema_name: 'answer' }],
      ['ollama json', 'pico_ollama_chat', { prompt, format: 'json', options: { num_predict: 1024 } }],
      ['chat content parts', 'pico_chat_completions', { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], max_tokens: 1024 }],
      ['responses system item', 'pico_responses', { input: [{ role: 'system', content: 'Answer briefly.' }, { role: 'user', content: prompt }], max_output_tokens: 1024 }],
      ['chat system', 'pico_chat_completions', { prompt, system: 'Answer briefly.', max_tokens: 1024 }],
      ['responses instructions', 'pico_responses', { input: prompt, instructions: 'Answer briefly.', max_output_tokens: 1024 }],
      ['ollama keep_alive', 'pico_ollama_chat', { prompt, keep_alive: '5m', options: { num_predict: 1024 } }],
      ['chat extra seed', 'pico_chat_completions', { prompt, max_tokens: 1024, extra: { seed: 1 } }]
    ]) await t.test(label + ' (' + toolsModel + ')', async () => {
      await generation(label, toolsModel, () => callTool(name, { model: toolsModel, ...args }, ctx), data => {
        assert.ok(hasAnswer(data.answer), 'Missing answer: ' + JSON.stringify(data));
      });
    });
    await t.test('responses accepts previous_response_id (' + toolsModel + ')', async () => {
      const first = await checked('pico_responses', { model: toolsModel, input: prompt, max_output_tokens: 1024 });
      assert.equal(typeof first.response_id, 'string');
      await generation('responses accepts previous_response_id', toolsModel, () => callTool('pico_responses', { model: toolsModel, input: prompt, previous_response_id: first.response_id, max_output_tokens: 1024 }, ctx), () => {});
    });

    await t.test('pico_responses reasoning_effort reaches Pico as reasoning.effort (' + toolsModel + ')', async () => {
      const args = { model: toolsModel, input: prompt, max_output_tokens: 1024 };
      await generation('pico_responses reasoning_effort', toolsModel,
        () => callTool('pico_responses', { ...args, reasoning_effort: 'low' }, ctx), data => {
          assert.ok(hasAnswer(data.answer), 'Missing reasoning answer: ' + JSON.stringify(data));
        });
      const invalid = await callTool('pico_responses', { ...args, reasoning_effort: 'pico-ai-bridge-invalid-effort' }, ctx);
      assert.equal(invalid.isError, true);
      assert.equal(invalid.structuredContent.source, 'pico');
      assert.equal(invalid.structuredContent.status, 400);
    });

    const directory = await mkdtemp(join(tmpdir(), 'pico-vision-'));
    try {
      const image = join(directory, 'red.png');
      await writeFile(image, solidPng());
      const visionPrompt = 'What color is this image? Answer in one word.';
      for (const [name, args] of [
        ['pico_responses', { input: visionPrompt, max_output_tokens: 1024 }],
        ['pico_chat_completions', { prompt: visionPrompt, max_tokens: 1024 }],
        ['pico_ollama_chat', { prompt: visionPrompt, options: { num_predict: 1024 } }]
      ]) await t.test(name + ' vision default (' + visionModel + ')', async () => {
        await generation(name + ' vision default', visionModel, () => callTool(name, { model: visionModel, ...args, images: [image] }, ctx), data => {
          assert.ok(hasAnswer(data.answer), 'Missing vision answer: ' + JSON.stringify(data));
          assert.match(data.answer, /red/i);
        });
      });
      const upperUri = 'DATA:image/png;base64,' + solidPng().toString('base64');
      for (const [label, name, args, red] of [
        ['ollama uppercase data URI', 'pico_ollama_chat', { prompt: visionPrompt, images: [upperUri], options: { num_predict: 1024 } }, true],
        ['chat content parts', 'pico_chat_completions', { messages: [{ role: 'user', content: [{ type: 'text', text: visionPrompt }] }], images: [image], max_tokens: 1024 }, true],
        ['chat image only', 'pico_chat_completions', { images: [image], max_tokens: 1024 }, false],
        ['responses image only', 'pico_responses', { images: [image], max_output_tokens: 1024 }, false],
        ['ollama image only', 'pico_ollama_chat', { images: [image], options: { num_predict: 1024 } }, false]
      ]) await t.test(label + ' vision (' + visionModel + ')' + (red ? '' : ' (answer only)'), async () => {
        await generation(label + ' vision', visionModel, () => callTool(name, { model: visionModel, ...args }, ctx), data => {
          assert.ok(hasAnswer(data.answer), 'Missing vision answer: ' + JSON.stringify(data));
          if (red) assert.match(data.answer, /red/i);
        });
      });
      const visionCompareModels = [...new Set([visionModel, toolsModel])];
      if (visionCompareModels.length === 1) visionCompareModels.push(visionModel);
      await t.test('compare_models chat_completions image default', async () => {
        await generation('compare_models chat_completions image default', visionCompareModels.join(', '),
          () => callTool('pico_compare_models', { models: visionCompareModels, prompt: visionPrompt, images: [image], api: 'chat_completions', temperature: 0, max_tokens: 1024 }, ctx),
          data => {
            assert.equal(data.api, 'chat_completions');
            assert.equal(data?.results?.length, visionCompareModels.length);
            for (const [index, row] of data.results.entries()) {
              assert.equal(row.model, visionCompareModels[index]);
              assert.equal(row.error, undefined, row.model + ': ' + JSON.stringify(row.error));
              assert.ok(hasAnswer(row.answer), row.model + ': missing answer: ' + JSON.stringify(row));
            }
          });
      });
    } finally { await rm(directory, { recursive: true, force: true }); }

    for (const thinkingModel of thinkingModels) {
      await t.test('pico_ollama_chat think:true (' + thinkingModel + ')', async () => {
        await generation('pico_ollama_chat think:true', thinkingModel,
          () => callTool('pico_ollama_chat', { model: thinkingModel, prompt, think: true, options: { num_predict: 3072, temperature: 0 } }, ctx), data => {
            assert.ok(hasAnswer(data.answer), 'Missing thinking answer: ' + JSON.stringify(data));
          });
      });
      for (const split_thinking of [true, false]) await t.test('pico_ollama_chat think:false split_thinking:' + split_thinking + (split_thinking ? ' keeps no think pair (' : ' leaves inline text (') + thinkingModel + ')', async () => {
        await generation('pico_ollama_chat think:false split_thinking:' + split_thinking, thinkingModel,
          () => callTool('pico_ollama_chat', { model: thinkingModel, prompt, think: false, options: { num_predict: 3072, temperature: 0 }, split_thinking }, ctx), data => {
            if (split_thinking) {
              console.log('pico_ollama_chat think:false split_thinking:true (' + thinkingModel + ') inline reasoning found: ' + hasAnswer(data.reasoning));
              assert.ok(hasAnswer(data.answer) || hasAnswer(data.reasoning), 'Missing answer and reasoning: ' + JSON.stringify(data));
              assert.doesNotMatch(data.answer, /<think>[\s\S]*?<\/think>/);
              if (hasAnswer(data.reasoning)) assert.ok(!data.reasoning.includes('<think>') && !data.reasoning.includes('</think>'), 'Think tag remains in reasoning: ' + JSON.stringify(data));
            } else {
              assert.ok(hasAnswer(data.answer), 'Missing thinking answer: ' + JSON.stringify(data));
              assert.equal(data.reasoning, '');
            }
          });
      });
    }

    const checkModelError = async (model, expectedStatus) => {
      for (const [name, path, args, body] of [
        ['pico_responses', '/v1/responses', { input: 'hi', max_output_tokens: 1024 }, { input: 'hi', stream: false, max_output_tokens: 1024 }],
        ['pico_chat_completions', '/v1/chat/completions', { prompt: 'hi', max_tokens: 1024 }, { messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 1024 }],
        ['pico_ollama_chat', '/api/chat', { prompt: 'hi', options: { num_predict: 1024 } }, { messages: [{ role: 'user', content: 'hi' }], stream: false, options: { num_predict: 1024 } }]
      ]) {
        const payload = JSON.stringify({ model, ...body });
        const direct = await new Promise((resolve, reject) => {
          const url = new URL(ctx.config.baseUrl + path);
          const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers: {
            'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
            ...(ctx.config.apiKey ? { authorization: `Bearer ${ctx.config.apiKey}` } : {})
          } }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
            response.on('error', reject);
          });
          request.on('error', reject);
          request.end(payload);
        });
        if (expectedStatus !== undefined) assert.equal(direct.status, expectedStatus, name);
        else assert.ok(direct.status >= 400, name);
        const raw = await callTool(name, { model, ...args, raw: true }, ctx);
        const normal = await callTool(name, { model, ...args }, ctx);
        for (const response of [raw, normal]) {
          assert.equal(response.isError, true, name);
          assert.equal(response.structuredContent.source, 'pico', name);
          assert.equal(response.structuredContent.status, direct.status, name);
        }
        assert.deepStrictEqual(normal.structuredContent, raw.structuredContent, name);
        const directBody = redactPicoData(direct.body, ctx.config);
        assert.deepStrictEqual(raw.structuredContent.body, directBody, name);
        assert.deepStrictEqual(normal.structuredContent.body, directBody, name);
      }
    };

    await t.test('unknown model matches direct Pico 404', () => checkModelError('pico-ai-bridge-no-such-model', 404));

    if (process.env.PICO_TEST_BROKEN_MODEL) {
      await t.test('configured broken model matches direct Pico error in all APIs', () => checkModelError(process.env.PICO_TEST_BROKEN_MODEL));
      await t.test('comparison continues after a broken model', async () => {
        const response = await callTool('pico_compare_models', { models: [process.env.PICO_TEST_BROKEN_MODEL, toolsModel], prompt, api: 'chat_completions', temperature: 0, max_tokens: 3072 }, ctx);
        assert.equal(response.isError, undefined);
        const rows = response.structuredContent.results;
        assert.equal(rows.length, 2);
        assert.equal(rows[0].error?.source, 'pico');
        assert.equal(typeof rows[0].error.status, 'number');
        assert.equal(rows[1].error, undefined);
        assert.ok(hasAnswer(rows[1].answer));
      });
    }

    await t.test('comparison waits for a timed-out request before the next model', async () => {
      const picoBase = readConfig(process.env).baseUrl;
      const arrivals = [];
      const forwarded = new Set();
      const proxy = http.createServer((request, response) => {
        const target = new URL(picoBase + request.url);
        const transport = target.protocol === 'https:' ? https : http;
        const timing = request.url.startsWith('/v1/chat/completions') ? { arrived: process.hrtime.bigint(), finished: null } : null;
        if (timing) arrivals.push(timing);
        let done;
        const finished = new Promise(resolve => { done = resolve; });
        forwarded.add(finished);
        const complete = () => { forwarded.delete(finished); done(); };
        response.once('finish', () => { if (timing) timing.finished = process.hrtime.bigint(); complete(); });
        response.once('close', complete);
        const upstream = transport.request(target, { method: request.method, headers: { ...request.headers, host: target.host }, timeout: 0 }, incoming => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(response);
        });
        upstream.on('error', error => { if (!response.headersSent) response.writeHead(502); response.end(String(error)); });
        request.pipe(upstream);
      });
      proxy.requestTimeout = 0;
      proxy.timeout = 0;
      await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
      try {
        const shortCtx = createContext(readConfig({ ...process.env, PICO_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, PICO_TIMEOUT_MS: '1000', PICO_MAX_CONCURRENT_REQUESTS: '2' }));
        const response = await callTool('pico_compare_models', { models: [toolsModel, toolsModel], prompt: 'Write a 1500-word story about a lighthouse keeper.', api: 'chat_completions', temperature: 0, max_tokens: 4096 }, shortCtx);
        assert.equal(response.isError, undefined);
        const rows = response.structuredContent.results;
        assert.equal(rows.length, 2);
        assert.equal(rows[0].error?.kind, 'timeout');
        assert.ok(rows[1].error?.kind === 'timeout' || rows[1].error === undefined && hasAnswer(rows[1].answer));
        assert.equal(arrivals.length, 2);
        assert.ok(arrivals[0].finished !== null);
        assert.ok(arrivals[1].arrived >= arrivals[0].finished, 'Second comparison request arrived before the first response finished.');
      } finally {
        await Promise.all([...forwarded]);
        await new Promise(resolve => proxy.close(resolve));
      }
      const info = await checked('pico_server_info', {});
      assert.equal(info.reachable, true);
      const chat = await checked('pico_chat_completions', { model: toolsModel, prompt: 'Say hello in one sentence.', temperature: 0, max_tokens: 64 });
      assert.ok(hasAnswer(chat.answer));
    });

    for (const [api, raw] of [['chat_completions', false], ['responses', false], ['ollama', false], ['chat_completions', true], ['responses', true], ['ollama', true]]) await t.test('compare_models ' + api + ' ' + (raw ? 'raw' : 'default'), async () => {
      await generation('compare_models ' + api + ' ' + (raw ? 'raw' : 'default'), models.join(', '),
        () => callTool('pico_compare_models', { models, prompt, api, max_tokens: 3072, temperature: 0, raw }, ctx),
        data => {
          assert.equal(data.api, api);
          assert.equal(data?.results?.length, models.length);
          for (const [index, row] of data.results.entries()) {
            assert.equal(row.model, models[index]);
            if (api !== 'responses' || raw) assert.equal(row.error, undefined, row.model + ': ' + JSON.stringify(row.error));
            else assert.ok('error' in row && 'incomplete_details' in row);
            if (raw) {
              assert.equal(row.status, 200);
              assert.ok(row.body && typeof row.body === 'object' && !Array.isArray(row.body), row.model + ': missing body: ' + JSON.stringify(row));
              if (api === 'responses') assert.ok(Array.isArray(row.body.output), row.model + ': missing output: ' + JSON.stringify(row));
              else if (api === 'ollama') assert.ok(row.body.message && typeof row.body.message === 'object', row.model + ': missing message: ' + JSON.stringify(row));
              else assert.ok(hasAnswer(row.body.choices?.[0]?.message?.content), row.model + ': missing answer: ' + JSON.stringify(row));
            } else {
              assert.ok(hasAnswer(row.answer), row.model + ': missing answer: ' + JSON.stringify(row));
              assert.equal(row.response_model, row.model);
              if (api === 'chat_completions') assert.equal(typeof row.finish_reason, 'string');
              else if (api === 'responses') assert.equal(row.status, 'completed');
              else assert.ok(row.durations_ms && typeof row.durations_ms === 'object');
            }
          }
        });
    });
    for (const api of ['chat_completions', 'responses', 'ollama']) await t.test('compare_models ' + api + ' messages default', async () => {
      await generation('compare_models ' + api + ' messages default', models.join(', '),
        () => callTool('pico_compare_models', { models, messages: [{ role: 'user', content: prompt }], api, temperature: 0, max_tokens: 1024 }, ctx),
        data => {
          assert.equal(data.api, api);
          assert.equal(data?.results?.length, models.length);
          for (const row of data.results) {
            assert.ok(row.error == null, row.model + ': ' + JSON.stringify(row.error));
            assert.ok(hasAnswer(row.answer), row.model + ': missing answer: ' + JSON.stringify(row));
          }
        });
    });
  } finally {
    console.log('\nGeneration outcomes');
    console.log('Test | Model | Final outcome');
    console.log('--- | --- | ---');
    for (const row of outcomes) console.log(row.name + ' | ' + row.model + ' | ' + row.outcome);
  }
});
