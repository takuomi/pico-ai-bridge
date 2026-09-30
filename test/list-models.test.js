import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool, createContext } from '../server/core/registry.js';
import { fixture } from './fixtures.js';
import { v1Models, apiTags, apiShow, badTagSize, badModelStatus, badShowFields, badContextLengths } from './fixtures-pico.js';
test('model list rejects nonnumeric tag size', async () => {
  const f = await fixture(call => ({ body: call.path === '/api/tags' ? badTagSize : { data: [] } }));
  try {
    const response = await callTool('pico_list_models', {}, f.ctx);
    assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'unexpected_response', message: 'Pico /api/tags returned a 2xx body that is not a model list.' });
  } finally { await f.close(); }
});
test('model list rejects nonfinite tag size parsed from JSON', async () => {
  const f = await fixture(call => ({ body: call.path === '/api/tags' ? '{"models":[{"name":"bad:latest","size":1e309}]}' : { data: [] } }));
  try {
    const response = await callTool('pico_list_models', {}, f.ctx);
    assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'response_parse_failed', message: 'Pico returned numbers JSON cannot represent exactly: {"models":[{"name":"bad:latest","size":1e309}]}' });
    const raw = await callTool('pico_list_models', { raw: true }, f.ctx);
    assert.equal(raw.structuredContent.api_tags.body, '{"models":[{"name":"bad:latest","size":1e309}]}');
  } finally { await f.close(); }
});
test('model list merges captured Pico bodies and preserves raw endpoint bodies', async () => {
  const bodies = { '/v1/models': v1Models, '/api/tags': apiTags };
  const f = await fixture(call => ({ body: call.path === '/api/show' ? apiShow[call.body.model] : bodies[call.path] }));
  try {
    const normal = await callTool('pico_list_models', { include_capabilities: true }, f.ctx);
    assert.deepEqual(f.calls.filter(call => call.path === '/api/show').map(call => call.body.model), v1Models.data.map(item => item.id + ':latest'));
    const raw = await callTool('pico_list_models', { include_capabilities: true, raw: true }, f.ctx);
    const models = normal.structuredContent.models;
    assert.equal(models.length, 5);
    assert.deepEqual(models.map(model => [model.id, model.name]), [
      ['deepseek-r1-distill-qwen-1.5b-4bit', 'deepseek-r1-distill-qwen-1.5b-4bit:latest'],
      ['gemma-4-12B-it-qat-4bit', 'gemma-4-12B-it-qat-4bit:latest'],
      ['gpt-oss-20b-MXFP4-Q8', 'gpt-oss-20b-MXFP4-Q8:latest'],
      ['LFM2.5-1.2B-Thinking-4bit', 'LFM2.5-1.2B-Thinking-4bit:latest'],
      ['Qwen3-VL-2B-Instruct-4bit', 'Qwen3-VL-2B-Instruct-4bit:latest']
    ]);
    assert.equal(models[0].created, -62135769600);
    assert.deepEqual([models[1].size_bytes, models[1].size_gb], [0, 0]);
    for (const model of models) {
      const v1 = v1Models.data.find(item => item.id === model.id);
      const tag = apiTags.models.find(item => item.name === model.name);
      const show = apiShow[model.name];
      assert.deepEqual(Object.keys(model), ['id', 'name', 'display_name', 'tag_model', 'status', 'created', 'owned_by', 'format', 'family', 'parameter_size', 'quantization_level', 'size_bytes', 'size_gb', 'modified_at', 'capabilities', 'context_length']);
      assert.equal(model.display_name, v1Models.models.find(item => item.model === model.id).name);
      assert.equal(model.tag_model, tag.model);
      assert.equal(model.status, v1.status.value);
      assert.equal(model.created, v1.created);
      assert.equal(model.owned_by, v1.owned_by);
      for (const key of ['format', 'family', 'parameter_size', 'quantization_level']) assert.equal(model[key], tag.details[key]);
      assert.equal(model.size_bytes, tag.size);
      assert.equal(model.size_gb, Number((tag.size / 1e9).toFixed(2)));
      assert.equal(model.modified_at, tag.modified_at);
      assert.deepEqual(model.capabilities, show.capabilities);
      assert.equal(model.context_length, show.model_info['llama.context_length']);
    }
    assert.deepEqual(raw.structuredContent.v1_models.body, v1Models);
    assert.deepEqual(raw.structuredContent.api_tags.body, apiTags);
    for (const [name, body] of Object.entries(apiShow)) assert.deepEqual(raw.structuredContent.api_show[name].body, body);
    assert.deepEqual(f.calls.filter(call => call.path === '/api/show').map(call => call.body.model), [...models.map(model => model.name), ...models.map(model => model.name)]);
    for (const key of ['extra', 'split_thinking']) {
      const invalid = await callTool('pico_list_models', { [key]: key === 'extra' ? {} : false }, f.ctx);
      assert.equal(invalid.structuredContent.kind, 'invalid_arguments');
    }
  } finally { await f.close(); }
});
test('model list merges tagged names after the last slash', async () => {
  const cases = [
    { ids: ['x:q4', 'x'], name: 'x:q4', expected: [['x:q4', 'x:q4'], ['x', null]] },
    { ids: ['org/x'], name: 'org/x:latest', expected: [['org/x', 'org/x:latest']] },
    { ids: ['host:5000/x'], name: 'host:5000/x:latest', expected: [['host:5000/x', 'host:5000/x:latest']] }
  ];
  for (const { ids, name, expected } of cases) {
    const f = await fixture(call => ({ body: call.path === '/v1/models' ? { data: ids.map(id => ({ id })) } : { models: [{ name }] } }));
    try {
      const response = await callTool('pico_list_models', {}, f.ctx);
      assert.deepEqual(response.structuredContent.models.map(model => [model.id, model.name]), expected);
    } finally { await f.close(); }
  }
});
test('model list retains entries from only one endpoint and shows by available name', async () => {
  const f = await fixture(call => ({ body: call.path === '/v1/models' ? { data: [{ id: 'only-v1' }] }
    : call.path === '/api/tags' ? { models: [{ name: 'only-tag:latest' }] } : { capabilities: [] } }));
  try {
    const response = await callTool('pico_list_models', { include_capabilities: true }, f.ctx);
    const [v1, tag] = response.structuredContent.models;
    assert.deepEqual([v1.id, v1.name, v1.display_name, v1.status, v1.format, v1.family, v1.parameter_size, v1.quantization_level, v1.size_bytes, v1.size_gb, v1.modified_at],
      ['only-v1', null, null, null, null, null, null, null, null, null, null]);
    assert.deepEqual([tag.id, tag.name, tag.display_name, tag.status], [null, 'only-tag:latest', null, null]);
    assert.deepEqual(f.calls.filter(call => call.path === '/api/show').map(call => call.body.model), ['only-v1', 'only-tag:latest']);
  } finally { await f.close(); }
});
test('model list rejects malformed display models and nameless tags', async () => {
  for (const [path, body] of [
    ['/v1/models', { data: [{ id: 'x' }], models: [null] }],
    ['/v1/models', { data: [{ id: 'x' }], models: {} }],
    ['/api/tags', { models: [{ model: 'x:latest' }] }]
  ]) {
    const f = await fixture(call => ({ body: call.path === path ? body : call.path === '/v1/models' ? { data: [] } : { models: [] } }));
    try {
      const response = await callTool('pico_list_models', {}, f.ctx);
      assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'unexpected_response', message: `Pico ${path} returned a 2xx body that is not a model list.` });
    } finally { await f.close(); }
  }
});
test('model list reports both Pico endpoint failures in default and raw modes', async () => {
  const f = await fixture(call => ({ status: call.path === '/v1/models' ? 404 : 503, body: { path: call.path } }));
  try {
    const normal = await callTool('pico_list_models', {}, f.ctx);
    assert.equal(normal.isError, true);
    assert.deepEqual(normal.structuredContent, { models: [], partial_errors: [
      { path: '/v1/models', error: { source: 'pico', status: 404, body: { path: '/v1/models' } } },
      { path: '/api/tags', error: { source: 'pico', status: 503, body: { path: '/api/tags' } } }
    ] });
    assert.equal(normal.content[0].text, 'Pico AI Server returned HTTP 404: {"path":"/v1/models"} (/v1/models)\nPico AI Server returned HTTP 503: {"path":"/api/tags"} (/api/tags)');
    const raw = await callTool('pico_list_models', { raw: true }, f.ctx);
    assert.equal(raw.isError, true);
    assert.equal(raw.structuredContent.v1_models.status, 404);
    assert.equal(raw.structuredContent.api_tags.status, 503);
  } finally { await f.close(); }
});
test('model list partial errors include endpoint path', async () => {
  const f = await fixture(call => call.path === '/v1/models' ? { status: 500, body: 'failed' } : { body: { models: [{ name: 'm' }] } });
  try {
    const response = await callTool('pico_list_models', {}, f.ctx);
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.structuredContent.partial_errors, [{ path: '/v1/models', error: { source: 'pico', status: 500, body: 'failed' } }]);
  } finally { await f.close(); }
});
test('raw model list flags a failed capability lookup', async () => {
  const f = await fixture(call => call.path === '/v1/models' ? { body: { data: [{ id: 'm' }] } } :
    call.path === '/api/tags' ? { body: { models: [] } } : { status: 404, body: 'missing' });
  try {
    const response = await callTool('pico_list_models', { raw: true, include_capabilities: true }, f.ctx);
    assert.equal(response.isError, true);
    assert.deepEqual(response.structuredContent.api_show.m, { status: 404, body: 'missing' });
  } finally { await f.close(); }
});
test('default model list keeps Pico capability error shape', async () => {
  const f = await fixture(call => call.path === '/v1/models' ? { body: { data: [{ id: 'm' }] } } :
    call.path === '/api/tags' ? { body: { models: [] } } : { status: 404, body: { error: 'missing' } });
  try {
    const response = await callTool('pico_list_models', { include_capabilities: true }, f.ctx);
    assert.deepEqual(response.structuredContent.models[0].capabilities_error, { source: 'pico', status: 404, body: { error: 'missing' } });
  } finally { await f.close(); }
});

test('model extraction rejects malformed successful lists while plain raw preserves them', async () => {
  for (const [path, key, field] of [['/v1/models', 'data', 'v1_models'], ['/api/tags', 'models', 'api_tags']]) {
    for (const body of [{ [key]: {} }, { [key]: [null] }, {}, { [key]: [{}] }, { [key]: [7] }, { [key]: [{ id: 1, name: 1, model: 1 }] }, null, []]) {
      const f = await fixture(call => ({ body: call.path === path ? body : call.path === '/v1/models' ? { data: [] } : { models: [] } }));
      try {
        const raw = await callTool('pico_list_models', { raw: true }, f.ctx);
        assert.equal(raw.isError, undefined);
        assert.deepEqual(raw.structuredContent[field], { status: 200, body });
        for (const args of [{}, { include_capabilities: true }, { raw: true, include_capabilities: true }]) {
          const response = await callTool('pico_list_models', args, f.ctx);
          assert.equal(response.isError, true);
          assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'unexpected_response', message: `Pico ${path} returned a 2xx body that is not a model list.` });
        }
        assert.ok(f.calls.every(call => call.path !== '/api/show'));
      } finally { await f.close(); }
    }
  }
});
test('model identifiers and tag names may be empty strings', async () => {
  const f = await fixture(call => ({ body: call.path === '/v1/models' ? { data: [{ id: '' }] } : { models: [{ name: '' }] } }));
  try { assert.deepEqual((await callTool('pico_list_models', {}, f.ctx)).structuredContent.models.map(item => [item.id, item.name]), [['', '']]); }
  finally { await f.close(); }
});
test('model list rejects a malformed present status and preserves it in raw mode', async () => {
  const f = await fixture(call => ({ body: call.path === '/v1/models' ? badModelStatus : { models: [] } }));
  try {
    const response = await callTool('pico_list_models', {}, f.ctx);
    assert.deepEqual(response.structuredContent, { source: 'bridge', kind: 'unexpected_response', message: 'Pico /v1/models returned a 2xx body that is not a model list.' });
    const raw = await callTool('pico_list_models', { raw: true }, f.ctx);
    assert.deepEqual(raw.structuredContent.v1_models.body, badModelStatus);
  }
  finally { await f.close(); }
});
test('raw capability listing accepts unrelated field shapes and calls show', async () => {
  const v1 = { data: [{ id: 'm', status: 'loading' }], models: { arbitrary: true } };
  const tags = { models: [{ name: 'm:latest', size: 'unknown', details: 7 }] };
  const f = await fixture(call => ({ body: call.path === '/v1/models' ? v1 : call.path === '/api/tags' ? tags : ['raw show'] }));
  try {
    const normal = await callTool('pico_list_models', { include_capabilities: true }, f.ctx);
    assert.equal(normal.structuredContent.kind, 'unexpected_response');
    const raw = await callTool('pico_list_models', { raw: true, include_capabilities: true }, f.ctx);
    assert.equal(raw.isError, undefined);
    assert.deepEqual(raw.structuredContent, { v1_models: { status: 200, body: v1 }, api_tags: { status: 200, body: tags }, api_show: { 'm:latest': { status: 200, body: ['raw show'] } } });
    assert.deepEqual(f.calls.filter(call => call.path === '/api/show').map(call => call.body.model), ['m:latest']);
  } finally { await f.close(); }
});
test('model list extracts null for absent or null status values', async () => {
  for (const status of [{}, { value: null }]) {
    const f = await fixture(call => ({ body: call.path === '/v1/models' ? { data: [{ id: 'm', status }] } : { models: [] } }));
    try { assert.equal((await callTool('pico_list_models', {}, f.ctx)).structuredContent.models[0].status, null); }
    finally { await f.close(); }
  }
});
test('model list rejects invalid status values and shapes', async () => {
  for (const status of [{ value: 1 }, []]) {
    const f = await fixture(call => ({ body: call.path === '/v1/models' ? { data: [{ id: 'm', status }] } : { models: [] } }));
    try { assert.equal((await callTool('pico_list_models', {}, f.ctx)).structuredContent.kind, 'unexpected_response'); }
    finally { await f.close(); }
  }
});
test('model ids reach capability lookup unchanged and are redacted in results', async () => {
  const id = 'model-secret';
  const f = await fixture(call => ({ body: call.path === '/v1/models' ? { data: [{ id }] }
    : call.path === '/api/tags' ? { models: [] } : { capabilities: ['secret'] } }));
  try {
    const ctx = createContext({ ...f.config, apiKey: 'secret' });
    const normal = await callTool('pico_list_models', { include_capabilities: true }, ctx);
    const raw = await callTool('pico_list_models', { include_capabilities: true, raw: true }, ctx);
    assert.deepEqual(f.calls.filter(call => call.path === '/api/show').map(call => call.body.model), [id, id]);
    assert.equal(normal.structuredContent.models[0].id, 'model-[Redacted]');
    assert.deepEqual(normal.structuredContent.models[0].capabilities, ['[Redacted]']);
    assert.deepEqual(raw.structuredContent.api_show['model-[Redacted]'].body, { capabilities: ['[Redacted]'] });
  } finally { await f.close(); }
});
test('model list redacts API key in extracted model fields', async () => {
  const f = await fixture(call => ({ body: call.path === '/v1/models' ? { data: [{ id: 'm', status: { value: 'secret' } }] }
    : call.path === '/api/tags' ? { models: [] } : { capabilities: ['secret'] } }));
  try {
    const ctx = createContext({ ...f.config, apiKey: 'secret' });
    const response = await callTool('pico_list_models', { include_capabilities: true }, ctx);
    const model = response.structuredContent.models[0];
    assert.equal(model.status, '[Redacted]');
    assert.deepEqual(model.capabilities, ['[Redacted]']);
    for (const key of ['id', 'status', 'capabilities']) assert.ok(Object.keys(model).includes(key));
  } finally { await f.close(); }
});

test('raw capability lookup preserves the __proto__ model id and reports failures', async () => {
  const f = await fixture(call => call.path === '/v1/models' ? { body: { data: [{ id: '__proto__' }] } }
    : call.path === '/api/tags' ? { body: { models: [] } } : { body: { capabilities: ['vision'] } });
  try {
    const response = await callTool('pico_list_models', { raw: true, include_capabilities: true }, f.ctx);
    assert.equal(Object.hasOwn(response.structuredContent.api_show, '__proto__'), true);
    assert.deepEqual(response.structuredContent.api_show['__proto__'].body, { capabilities: ['vision'] });
    assert.match(response.content[0].text, /"__proto__":\{"status":200/);
  } finally { await f.close(); }

  const failed = await fixture(call => call.path === '/v1/models' ? { body: { data: [{ id: '__proto__' }] } }
    : call.path === '/api/tags' ? { body: { models: [] } } : { status: 503, body: 'unavailable' });
  try {
    const response = await callTool('pico_list_models', { raw: true, include_capabilities: true }, failed.ctx);
    assert.equal(response.isError, true);
    assert.equal(Object.hasOwn(response.structuredContent.api_show, '__proto__'), true);
    assert.deepEqual(response.structuredContent.api_show['__proto__'], { status: 503, body: 'unavailable' });
  } finally { await failed.close(); }
});

test('missing capabilities in a successful show response are null', async () => {
  const f = await fixture(call => call.path === '/v1/models' ? { body: { data: [{ id: 'm' }] } }
    : call.path === '/api/tags' ? { body: { models: [] } } : { body: {} });
  try {
    const response = await callTool('pico_list_models', { include_capabilities: true }, f.ctx);
    assert.equal(response.structuredContent.models[0].capabilities, null);
  } finally { await f.close(); }
});
test('model list rejects a 2xx /api/show body that is not an object in default mode', async () => {
  const f = await fixture(call => ({ body: call.path === '/v1/models' ? { data: [{ id: 'm' }] }
    : call.path === '/api/tags' ? { models: [] } : [] }));
  try {
    const normal = await callTool('pico_list_models', { include_capabilities: true }, f.ctx);
    assert.deepEqual(normal.structuredContent, { source: 'bridge', kind: 'unexpected_response', message: 'Pico /api/show returned a 2xx body that is not an object.' });
    const raw = await callTool('pico_list_models', { include_capabilities: true, raw: true }, f.ctx);
    assert.deepEqual(raw.structuredContent.api_show.m, { status: 200, body: [] });
  } finally { await f.close(); }
});
test('model list rejects malformed capabilities and model_info in default mode', async () => {
  for (const show of badShowFields) {
    const f = await fixture(call => ({ body: call.path === '/v1/models' ? { data: [{ id: 'm' }] }
      : call.path === '/api/tags' ? { models: [] } : show }));
    try {
      const normal = await callTool('pico_list_models', { include_capabilities: true }, f.ctx);
      assert.deepEqual(normal.structuredContent, { source: 'bridge', kind: 'unexpected_response', message: 'Pico /api/show returned a 2xx body with invalid capabilities or model_info.' });
      const raw = await callTool('pico_list_models', { include_capabilities: true, raw: true }, f.ctx);
      assert.deepEqual(raw.structuredContent.api_show.m.body, show);
    } finally { await f.close(); }
  }
});
test('model list rejects nonnumeric and nonfinite context lengths in default mode', async () => {
  for (const show of badContextLengths) {
    const f = await fixture(call => ({ body: call.path === '/v1/models' ? { data: [{ id: 'm' }] }
      : call.path === '/api/tags' ? { models: [] } : show }));
    try {
      const normal = await callTool('pico_list_models', { include_capabilities: true }, f.ctx);
      assert.deepEqual(normal.structuredContent, typeof show === 'string'
        ? { source: 'bridge', kind: 'response_parse_failed', message: `Pico returned numbers JSON cannot represent exactly: ${show}` }
        : { source: 'bridge', kind: 'unexpected_response', message: 'Pico /api/show returned a 2xx body with invalid context_length.' });
      const raw = await callTool('pico_list_models', { include_capabilities: true, raw: true }, f.ctx);
      assert.deepEqual(raw.structuredContent.api_show.m.body, show);
    } finally { await f.close(); }
  }
});
test('model list keeps absent and null optional fields as null', async () => {
  const f = await fixture(call => ({ body: call.path === '/v1/models' ? { data: [{ id: 'm', status: null }] }
    : call.path === '/api/tags' ? { models: [] } : { capabilities: null, model_info: { 'llama.context_length': null } } }));
  try {
    const response = await callTool('pico_list_models', { include_capabilities: true }, f.ctx);
    assert.deepEqual([response.structuredContent.models[0].status, response.structuredContent.models[0].capabilities, response.structuredContent.models[0].context_length], [null, null, null]);
  } finally { await f.close(); }
});
