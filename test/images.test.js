import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { imageDataUri, messagesFor, parseArguments } from '../server/core/util.js';
test('local paths convert without inspecting bytes; URLs pass through', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pico-images-'));
  try {
    const file = join(dir, 'a.heic'); await writeFile(file, 'not an image');
    assert.equal(await imageDataUri(file), 'data:image/heic;base64,bm90IGFuIGltYWdl');
    assert.equal(await imageDataUri('https://example.test/a.png'), 'https://example.test/a.png');
    assert.equal((await messagesFor({ prompt: 'see', images: [file] }, 'ollama'))[0].images[0], 'bm90IGFuIGltYWdl');
    assert.equal((await messagesFor({ prompt: 'see', images: ['https://example.test/a.png'] }, 'ollama'))[0].images[0], 'https://example.test/a.png');
    await assert.rejects(imageDataUri(join(dir, 'missing.png')), e => e.kind === 'image_read_failed' && /ENOENT/.test(e.message));
  } finally { await rm(dir, { recursive: true }); }
});
test('home-relative image paths expand before reading', async () => {
  const name = `pico-ai-bridge-nonexistent-${process.pid}.png`;
  await assert.rejects(imageDataUri(`~/${name}`), error => error.kind === 'image_read_failed' && error.message.includes(join(homedir(), name)));
});
test('image classification preserves leading spaces and accepts uppercase URI prefixes', async () => {
  for (const style of ['ollama', 'chat', 'responses']) {
    const args = image => style === 'responses' ? { input: 'see', images: [image] } : { prompt: 'see', images: [image] };
    for (const path of [' data:image/png;base64,YWJj', ' https://example.test/a.png'])
      await assert.rejects(messagesFor(args(path), style), error => error.kind === 'image_read_failed' && error.message.startsWith(`Could not read image ${path}:`));
    for (const [uri, expected] of [['Data:image/png;base64,YWJj', style === 'ollama' ? 'YWJj' : 'Data:image/png;base64,YWJj'], ['HTTPS://example.test/a.png', 'HTTPS://example.test/a.png']]) {
      const message = (await messagesFor(args(uri), style))[0];
      assert.equal(style === 'ollama' ? message.images[0] : style === 'chat' ? message.content.at(-1).image_url.url : message.content.at(-1).image_url, expected);
    }
  }
});
test('Ollama rejects a non-array user images field before reading a file', async () => {
  for (const images of [null, 'old', {}]) {
    await assert.rejects(messagesFor({ messages: [{ role: 'user', content: 'look', images }], images: ['/missing/image.png'] }, 'ollama'),
      error => error.kind === 'invalid_arguments' && error.message === 'Images require the user message images field to be an array.');
  }
});
test('argument parsing preserves non-string values and parses JSON strings', () => {
  assert.equal(parseArguments(undefined), undefined);
  assert.deepEqual(parseArguments({ x: 1 }), { x: 1 });
  assert.deepEqual(parseArguments('{"x":1}'), { x: 1 });
  assert.deepEqual(parseArguments('[1,2]'), [1, 2]);
  assert.equal(parseArguments('3'), 3);
  assert.equal(parseArguments('null'), null);
  assert.equal(parseArguments('not JSON'), 'not JSON');
  assert.deepEqual(parseArguments('{"n":9007199254740991}'), { n: Number.MAX_SAFE_INTEGER });
  assert.equal(parseArguments('{"n":9007199254740993}'), '{"n":9007199254740993}');
});

test('Ollama data URIs decode percent escapes as bytes', async () => {
  const images = ['data:image/png,%89PNG%0D%0A%1A%0A', 'DATA:image/png;BASE64,iVBORw0KGgo=', 'data:image/png;  BaSe64  ,%2B%2F8=', 'data:image/png;base64, iVBOR%0D%0Aw0KGgo= ', 'data:image/png;base64,iVBORw0KGgo', 'data:image/png,%GG', 'data:image/png,%', 'data:image/png,%2'];
  const messages = await messagesFor({ prompt: 'see', images }, 'ollama');
  assert.deepEqual(messages[0].images, ['iVBORw0KGgo=', 'iVBORw0KGgo=', '+/8=', 'iVBORw0KGgo=', 'iVBORw0KGgo=', 'JUdH', 'JQ==', 'JTI=']);
});
test('Ollama data URIs exclude fragments from the payload', async () => {
  const messages = await messagesFor({ prompt: 'see', images: ['data:image/png;base64,YWJj#x', 'data:image/png,abc#frag'] }, 'ollama');
  assert.deepEqual(messages[0].images, ['YWJj', 'YWJj']);
});
test('Ollama data URIs follow URL serialization before decoding', async () => {
  const cases = [
    ['data:image/png,ab\ncd', 'YWJjZA=='], ['data:image/png;base\n64,YWJj', 'YWJj'],
    ['data:image/png,abc  ', 'YWJj'], ['data:image/png,a\tb', 'YWI='],
    ['data:image/png,é', 'w6k='], ['data:image/png,a%0Ab', 'YQpi'],
    ['data:image/png,a b#c', 'YSBi'], ['data:,x?y#z', 'eD95']
  ];
  for (const [uri, expected] of cases) {
    const messages = await messagesFor({ prompt: 'see', images: [uri] }, 'ollama');
    assert.equal(messages[0].images[0], expected, uri);
  }
});
test('Ollama rejects malformed data URIs while other APIs pass them through', async () => {
  for (const uri of ['data:image/png;base64', 'data:image/png;base64,%GG', 'data:image/png;base64,a?', 'data:image/png;base64,a', 'data:image/png;base64,a===']) {
    await assert.rejects(messagesFor({ prompt: 'see', images: [uri] }, 'ollama'), error =>
      error.kind === 'invalid_arguments' && /Ollama image data URI/.test(error.message));
    for (const style of ['chat', 'responses']) {
      const args = style === 'responses' ? { input: 'see', images: [uri] } : { prompt: 'see', images: [uri] };
      const message = (await messagesFor(args, style))[0];
      assert.equal(style === 'chat' ? message.content.at(-1).image_url.url : message.content.at(-1).image_url, uri);
    }
  }
});
