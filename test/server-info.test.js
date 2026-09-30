import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../server/core/registry.js';
import { fixture } from './fixtures.js';
import { apiVersion } from './fixtures-pico.js';
test('server info default and raw; GET-only arguments are rejected', async () => {
  const body = apiVersion;
  const f = await fixture(() => ({ body }));
  try {
    const normal = await callTool('pico_server_info', {}, f.ctx);
    const raw = await callTool('pico_server_info', { raw: true }, f.ctx);
    assert.equal(normal.structuredContent.version, body.version);
    assert.equal(normal.structuredContent.bundle_identifier, body.bundle_identifier);
    assert.deepEqual(Object.keys(normal.structuredContent), ['reachable', 'base_url', 'version', 'name', 'build', 'bundle_identifier']);
    assert.deepEqual(raw.structuredContent, { status: 200, body });
    assert.equal(f.calls[1].body, undefined);
    for (const key of ['extra', 'split_thinking']) {
      const invalid = await callTool('pico_server_info', { [key]: key === 'extra' ? {} : false }, f.ctx);
      assert.equal(invalid.structuredContent.kind, 'invalid_arguments');
    }
  } finally { await f.close(); }
});

test('server info uses only supplied metadata and null for absent name and version', async () => {
  for (const [body, version, name] of [[{}, null, null], [{ version: 'v', name: 'N' }, 'v', 'N'], [{ Version: 'test' }, null, null]]) {
    const f = await fixture(() => ({ body }));
    try {
      assert.deepEqual((await callTool('pico_server_info', {}, f.ctx)).structuredContent,
        { reachable: true, base_url: f.config.baseUrl, version, name, build: null, bundle_identifier: null });
    } finally { await f.close(); }
  }
});
test('server info rejects a 2xx body that is not version information in default mode', async () => {
  for (const body of [null, [], 'text', 1, { version: 1 }, { name: false }]) {
    const f = await fixture((_call, res) => { res.end(JSON.stringify(body)); });
    try {
      const normal = await callTool('pico_server_info', {}, f.ctx);
      assert.equal(normal.isError, true);
      assert.deepEqual(normal.structuredContent, { source: 'bridge', kind: 'unexpected_response', message: 'Pico /api/version returned a 2xx body that is not server version information.' });
      assert.deepEqual((await callTool('pico_server_info', { raw: true }, f.ctx)).structuredContent, { status: 200, body });
    } finally { await f.close(); }
  }
});
test('server info redacts bundle_identifier from Pico data', async () => {
  const f = await fixture(() => ({ body: { bundle_identifier: 'com.secret.app' } }));
  try {
    const ctx = { ...f.ctx, config: { ...f.config, apiKey: 'secret' } };
    assert.equal((await callTool('pico_server_info', {}, ctx)).structuredContent.bundle_identifier, 'com.[Redacted].app');
  } finally { await f.close(); }
});
