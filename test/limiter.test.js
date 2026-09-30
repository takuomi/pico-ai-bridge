import test from 'node:test';
import assert from 'node:assert/strict';
import { createPicoClient } from '../server/pico-client.js';
import { fixture } from './fixtures.js';
test('FIFO limit holds through response body and allows configured concurrency', async () => {
  let active = 0, peak = 0;
  const f = await fixture(async (call, res) => { active++; peak = Math.max(active, peak); res.writeHead(200); await new Promise(resolve => setTimeout(resolve, 30)); res.end(JSON.stringify({ id: call.path })); active--; });
  try {
    const request = createPicoClient({ ...f.config, maxConcurrentRequests: 1 });
    await Promise.all(['/1', '/2', '/3'].map(path => request(path)));
    assert.deepEqual(f.calls.map(x => x.path), ['/1', '/2', '/3']); assert.equal(peak, 1);
    peak = 0; const parallel = createPicoClient({ ...f.config, maxConcurrentRequests: 2 });
    await Promise.all(['/4', '/5'].map(path => parallel(path))); assert.equal(peak, 2);
  } finally { await f.close(); }
});
test('a cancelled FIFO waiter is removed before reaching Pico', async () => {
  let releaseFirst;
  let firstSeen;
  const seen = new Promise(resolve => { firstSeen = resolve; });
  const f = await fixture(async (call, res) => {
    if (call.path === '/first') { firstSeen(); await new Promise(resolve => { releaseFirst = resolve; }); }
    res.end('{}');
  });
  try {
    const request = createPicoClient({ ...f.config, maxConcurrentRequests: 1 });
    const first = request('/first');
    await seen;
    const controller = new AbortController();
    const queued = request('/cancelled', { signal: controller.signal });
    controller.abort();
    await assert.rejects(queued, error => error.kind === 'cancelled' && error.message === 'Request cancelled before it was sent to Pico.');
    releaseFirst();
    await first;
    await request('/next');
    assert.deepEqual(f.calls.map(call => call.path), ['/first', '/next']);
  } finally { releaseFirst?.(); await f.close(); }
});
test('a timed out FIFO waiter is removed and later requests still pass', async () => {
  let releaseFirst, firstSeen;
  let firstFinished = false;
  const seen = new Promise(resolve => { firstSeen = resolve; });
  const f = await fixture(async (call, res) => {
    if (call.path === '/first') { firstSeen(); await new Promise(resolve => { releaseFirst = resolve; }); firstFinished = true; }
    res.end('{}');
  });
  try {
    const request = createPicoClient({ ...f.config, timeoutMs: 40, maxConcurrentRequests: 1 });
    const first = request('/first').catch(error => error);
    await seen;
    await assert.rejects(request('/queued'), error => {
      assert.deepEqual(error, { kind: 'timeout', message: 'Pico request timed out after 40 ms while waiting for a concurrency permit; it was not sent to Pico.' });
      return true;
    });
    assert.deepEqual(f.calls.map(call => call.path), ['/first']);
    releaseFirst();
    assert.equal((await first).kind, 'timeout');
    assert.deepEqual((await request('/third')).body, {});
    assert.equal(firstFinished, true);
    assert.deepEqual(f.calls.map(call => call.path), ['/first', '/third']);
  } finally { releaseFirst?.(); await f.close(); }
});
test('timeout keeps the socket and FIFO permit until Pico responds', async () => {
  let firstResponseSent = false, firstClosedEarly = false, secondArrivedEarly = false;
  let finishFirst;
  const finished = new Promise(resolve => { finishFirst = resolve; });
  const f = await fixture(async (call, res) => {
    if (call.path === '/first') {
      res.on('close', () => { if (!res.writableEnded) firstClosedEarly = true; });
      await new Promise(resolve => setTimeout(resolve, 150));
      res.end('{"first":true}');
      firstResponseSent = res.writableEnded;
      finishFirst();
    } else {
      secondArrivedEarly = !firstResponseSent;
      res.end('{"second":true}');
    }
  });
  try {
    const request = createPicoClient({ ...f.config, timeoutMs: 30, maxConcurrentRequests: 1 });
    const started = Date.now();
    let timeoutError;
    await assert.rejects(request('/first'), error => { timeoutError = error; return error.kind === 'timeout' && error.message === 'Pico request timed out after 30 ms; the request was not cancelled and keeps its concurrency permit until Pico finishes.'; });
    assert.equal(Object.keys(timeoutError).includes('settled'), false);
    assert.equal(typeof timeoutError.settled?.then, 'function');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 20 && elapsed < 150, `timeout took ${elapsed} ms`);
    assert.equal(firstResponseSent, false);
    await finished;
    assert.equal(await timeoutError.settled, undefined);
    const second = await request('/second');
    assert.deepEqual(second.body, { second: true });
    assert.deepEqual(f.calls.map(call => call.path), ['/first', '/second']);
    assert.equal(firstResponseSent, true);
    assert.equal(firstClosedEarly, false);
    assert.equal(secondArrivedEarly, false);
  } finally { await f.close(); }
});
test('cancellation during body reading keeps the permit until the body completes', async () => {
  let releaseBody;
  const bodyGate = new Promise(resolve => { releaseBody = resolve; });
  let bodyStarted;
  const reading = new Promise(resolve => { bodyStarted = resolve; });
  let bodyFinished = false;
  let secondArrivedWhileBodyOpen = false;
  const f = await fixture(async (call, res) => {
    if (call.path === '/first') {
      res.writeHead(200, { 'content-type': 'application/json' });
      await new Promise(resolve => res.write('{"ok":', resolve));
      bodyStarted();
      await bodyGate;
      res.end('true}');
      bodyFinished = res.writableEnded;
    } else if (call.path === '/checkpoint') {
      res.end('{}');
    } else {
      secondArrivedWhileBodyOpen = !bodyFinished;
      res.end('{}');
    }
  });
  let second;
  try {
    const request = createPicoClient({ ...f.config, timeoutMs: 10000, maxConcurrentRequests: 1 });
    const controller = new AbortController();
    const first = request('/first', { signal: controller.signal });
    await reading;
    controller.abort();
    const queuedController = new AbortController();
    const queued = request('/queued', { signal: queuedController.signal });
    queuedController.abort();
    await assert.rejects(queued, error => error.kind === 'cancelled');
    second = request('/second');
    await createPicoClient(f.config)('/checkpoint');
    assert.equal(bodyFinished, false);
    assert.equal(secondArrivedWhileBodyOpen, false);
    assert.deepEqual(f.calls.map(call => call.path), ['/first', '/checkpoint']);
    releaseBody();
    assert.deepEqual((await first).body, { ok: true });
    await second;
    assert.equal(secondArrivedWhileBodyOpen, false);
    assert.deepEqual(f.calls.map(call => call.path), ['/first', '/checkpoint', '/second']);
  } finally { releaseBody(); if (second) await second.catch(() => {}); await f.close(); }
});
