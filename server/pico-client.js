import http from 'node:http';
import https from 'node:https';
import { redact, redactPicoData } from './core/util.js';
import { nonFiniteNumbers } from './core/validate.js';

const agents = { 'http:': new http.Agent({ keepAlive: false }), 'https:': new https.Agent({ keepAlive: false }) };

export const errorDetail = (error, config) => {
  const cause = error?.cause;
  const causes = error instanceof AggregateError ? error.errors : cause instanceof AggregateError ? cause.errors : cause == null ? [] : [cause];
  const detail = causes.length ? ` (${causes.map(item => `${item?.code == null ? '' : `${item.code}: `}${String(item?.message ?? item)}`).join('; ')})` : '';
  return redact(`${String(error?.message ?? error)}${detail}`, config);
};

/** One FIFO permit covers the request and response body reading. */
export function createPicoClient(config) {
  const maximum = config.maxConcurrentRequests ?? 1;
  let active = 0;
  const queue = [];
  const cancelled = () => ({ kind: 'cancelled', message: 'Request cancelled before it was sent to Pico.' });
  const acquire = (signal, deadline) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    if (active < maximum) { active++; resolve(); return; }
    let timer;
    const remove = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); queue.splice(queue.indexOf(waiter), 1); };
    const waiter = { resolve: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(); } };
    const onAbort = () => { remove(); reject(cancelled()); };
    queue.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { remove(); reject({ kind: 'timeout', message: `Pico request timed out after ${config.timeoutMs} ms while waiting for a concurrency permit; it was not sent to Pico.` }); }, Math.max(0, deadline - performance.now()));
  });
  const release = () => { if (queue.length) queue.shift().resolve(); else active--; };
  return async function request(path, { method = 'GET', body, allowText = false, signal } = {}) {
    const deadline = performance.now() + config.timeoutMs;
    await acquire(signal, deadline);
    if (signal?.aborted) { release(); throw cancelled(); }
    if (performance.now() >= deadline) { release(); throw { kind: 'timeout', message: `Pico request timed out after ${config.timeoutMs} ms while waiting for a concurrency permit; it was not sent to Pico.` }; }
    const work = (async () => {
      try {
        const response = await new Promise((resolve, reject) => {
          let reading = false, ended = false, text = '';
          const fail = error => reject({ kind: 'connection_failed', message: `Could not ${reading ? 'read response from' : 'connect to'} ${config.baseUrl}: ${errorDetail(error, config)}` });
          try {
            const url = new URL(`${config.baseUrl}${path}`);
            const payload = body === undefined ? undefined : JSON.stringify(body);
            const headers = { ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) };
            const transport = url.protocol === 'https:' ? https : http;
            const req = transport.request(url, { method, headers, agent: agents[url.protocol] }, res => {
              reading = true;
              res.setEncoding('utf8');
              res.on('data', chunk => { text += chunk; });
              res.on('end', () => { ended = true; resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode <= 299, text }); });
              res.on('error', fail);
              res.on('aborted', () => fail(new Error('response aborted')));
              res.on('close', () => { if (!ended) fail(new Error('response closed before end')); });
            });
            req.on('error', fail);
            req.end(payload);
          } catch (error) { fail(error); }
        });
        const { text } = response;
        const cleanText = redactPicoData(text, config);
        let parsed = text;
        if (text) {
          try { parsed = JSON.parse(text); }
          catch { if (response.ok && !allowText) throw { kind: 'response_parse_failed', message: `Pico returned invalid JSON: ${cleanText}` }; }
          if (nonFiniteNumbers(parsed).length) {
            if (response.ok && !allowText) throw { kind: 'response_parse_failed', message: `Pico returned numbers JSON cannot represent exactly: ${cleanText}` };
            parsed = text;
          }
        }
        if (!response.ok) parsed = redactPicoData(parsed, config);
        if (!response.ok) throw { source: 'pico', status: response.status, body: parsed };
        return { status: response.status, body: parsed };
      } finally { release(); }
    })();
    work.catch(() => {});
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      const error = { kind: 'timeout', message: `Pico request timed out after ${config.timeoutMs} ms; the request was not cancelled and keeps its concurrency permit until Pico finishes.` };
      Object.defineProperty(error, 'settled', { value: work.then(() => {}, () => {}) });
      reject(error);
    }, Math.max(0, deadline - performance.now())); });
    try { return await Promise.race([work, timeout]); }
    finally { clearTimeout(timer); }
  };
}
