import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readConfig } from '../server/core/config.js';
import { callTool, createContext, tools } from '../server/core/registry.js';
import { fixture } from './fixtures.js';
test('environment settings and defaults', () => {
  assert.deepEqual(readConfig({ PICO_BASE_URL: 'http://localhost:11434', PICO_TIMEOUT_MS: '${user_config.timeout_ms}', PICO_MAX_CONCURRENT_REQUESTS: '' }),
    { baseUrl: 'http://localhost:11434', configurationError: null, apiKey: '', timeoutMs: 300000, maxConcurrentRequests: 1 });
  assert.equal(readConfig({ PICO_BASE_URL: 'http://localhost:11434', PICO_MAX_CONCURRENT_REQUESTS: '3' }).maxConcurrentRequests, 3);
});
test('numeric user settings declare supported bounds', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
  const plugin = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url)));
  assert.deepEqual({ min: manifest.user_config.timeout_ms.min, max: manifest.user_config.timeout_ms.max }, { min: 1, max: 2147483647 });
  assert.deepEqual({ min: plugin.userConfig.timeout_ms.min, max: plugin.userConfig.timeout_ms.max }, { min: 1, max: 2147483647 });
  for (const field of [manifest.user_config.max_concurrent_requests, plugin.userConfig.max_concurrent_requests])
    assert.deepEqual({ min: field.min, max: field.max }, { min: 1, max: Number.MAX_SAFE_INTEGER });
});

test('invalid configuration rejects every tool without contacting Pico', async () => {
  const f = await fixture(() => ({ body: {} }));
  try {
    for (const [env, message] of [
      [{}, 'PICO_BASE_URL is not set; configure base_url.'],
      [{ PICO_BASE_URL: '' }, 'PICO_BASE_URL is not set; configure base_url.'],
      [{ PICO_BASE_URL: ' \t ' }, 'PICO_BASE_URL is not set; configure base_url.'],
      [{ PICO_BASE_URL: '${user_config.base_url}' }, 'PICO_BASE_URL is not set; configure base_url.'],
      [{ PICO_BASE_URL: 'not a url' }, 'base_url must be an http or https URL.'],
      [{ PICO_BASE_URL: 'file:///tmp/pico' }, 'base_url must be an http or https URL.'],
      ...['bad', 'Infinity', '0', '0.5', '1.5', '2147483648'].map(value =>
        [{ PICO_BASE_URL: f.config.baseUrl, PICO_TIMEOUT_MS: value }, 'PICO_TIMEOUT_MS must be an integer from 1 through 2147483647.']),
      ...['bad', '1.5', '0', '9007199254740993'].map(value =>
        [{ PICO_BASE_URL: f.config.baseUrl, PICO_MAX_CONCURRENT_REQUESTS: value }, 'PICO_MAX_CONCURRENT_REQUESTS must be a safe integer of at least 1.'])
    ]) {
      const ctx = createContext(readConfig(env));
      for (const tool of tools) {
        const result = await callTool(tool.name, {}, ctx);
        assert.deepEqual(result.structuredContent, { source: 'bridge', kind: 'invalid_configuration', message });
        assert.equal(result.content[0].text, `Pico AI Bridge error (invalid_configuration): ${message}`);
      }
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('valid base URL reaches the configured host', async () => {
  const f = await fixture(() => ({ body: { version: 'test' } }));
  try {
    assert.equal(f.config.configurationError, null);
    const result = await callTool('pico_server_info', {}, f.ctx);
    assert.equal(result.isError, undefined);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('query and fragment delimiters are invalid configuration', () => {
  for (const suffix of ['?x=1', '#part', '?', '#']) {
    assert.deepEqual(readConfig({ PICO_BASE_URL: 'http://localhost:7426' + suffix }).configurationError,
      { kind: 'invalid_configuration', message: 'base_url must not contain a query or fragment.' });
  }
  assert.equal(readConfig({ PICO_BASE_URL: 'ftp://localhost/?' }).configurationError.message, 'base_url must be an http or https URL.');
  assert.equal(readConfig({ PICO_BASE_URL: 'http://user:pass@localhost/#' }).configurationError.message, 'base_url must not contain credentials; use api_key instead.');
});
