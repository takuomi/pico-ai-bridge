import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { nonFiniteNumbers } from './validate.js';

export const result = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
export const rawResult = (response, config) => {
  const body = redactPicoData(response.body, config);
  return { content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) }], structuredContent: { ...response, body } };
};
function redactValue(value, config, keys) {
  const clean = text => config.apiKey ? text.replaceAll(config.apiKey, '[Redacted]') : text;
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item, config, keys));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [keys ? clean(key) : key, redactValue(item, config, keys)]));
  return value;
}
export const redact = (value, config = { apiKey: '' }) => redactValue(value, config, false);
export const redactPicoData = (value, config = { apiKey: '' }) => redactValue(value, config, true);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const optionalFields = (value, fields) => Object.entries(fields).every(([key, valid]) => value[key] == null || valid(value[key]));
export const responseTypes = { string: value => typeof value === 'string', number: Number.isFinite, boolean: value => typeof value === 'boolean', object };
const content = value => value == null || typeof value === 'string';
const objects = value => value == null || (Array.isArray(value) && value.every(object));
const chatToolCalls = value => objects(value) && (value == null || value.every(item => typeof item.id === 'string' && typeof item.type === 'string' && (item.type === 'custom' ? object(item.custom) && typeof item.custom.name === 'string' && typeof item.custom.input === 'string' : object(item.function) && typeof item.function.name === 'string' && typeof item.function.arguments === 'string')));
export const chatCalls = (items, config) => (items ?? []).map(item => item.type === 'custom' ? redact({ id: item.id, type: item.type, name: item.custom.name, input: item.custom.input }, config) : { ...redact({ id: item.id, type: item.type, name: item.function.name }, config), arguments: redactPicoData(parseArguments(item.function.arguments), config) });
export const customToolCalls = (items, config) => items.filter(item => item.type === 'custom_tool_call').map(item => redact({ id: item.id ?? null, call_id: item.call_id, name: item.name, input: item.input, status: item.status ?? null }, config));
const ollamaToolCalls = value => objects(value) && (value == null || value.every(item => optionalFields(item, { id: responseTypes.string }) && object(item.function) && typeof item.function.name === 'string' && (item.function.arguments == null || object(item.function.arguments) || typeof item.function.arguments === 'string')));
const parts = value => value == null || (Array.isArray(value) && value.every(item => object(item) && typeof item.type === 'string' && optionalFields(item, { text: responseTypes.string, refusal: responseTypes.string }) && (!['output_text', 'summary_text', 'reasoning_text'].includes(item.type) || typeof item.text === 'string') && (item.type !== 'refusal' || typeof item.refusal === 'string')));
const usageFields = { input_tokens: responseTypes.number, output_tokens: responseTypes.number, total_tokens: responseTypes.number, prompt_time_ms: responseTypes.number, generation_time_ms: responseTypes.number };
const responseUsage = value => value == null || object(value) && optionalFields(value, { ...usageFields, input_tokens_details: responseTypes.object, output_tokens_details: responseTypes.object }) &&
  (value.input_tokens_details == null || optionalFields(value.input_tokens_details, { cached_tokens: responseTypes.number })) &&
  (value.output_tokens_details == null || optionalFields(value.output_tokens_details, { reasoning_tokens: responseTypes.number }));
export const responseRefusal = output => {
  const refusals = output.filter(item => item.type === 'message').flatMap(item => item.content ?? []).filter(part => part.type === 'refusal').map(part => part.refusal);
  return refusals.length ? refusals.join('') : null;
};
export const reasoningParts = item => item.summary?.length ? item.summary : item.content ?? [];
export function expectChatCompletion(data) {
  if (!object(data) || !optionalFields(data, { id: responseTypes.string, model: responseTypes.string, created: responseTypes.number, usage: responseTypes.object }) || !Array.isArray(data.choices) || !data.choices.length || !object(data.choices[0]) || !optionalFields(data.choices[0], { finish_reason: responseTypes.string }) || !object(data.choices[0].message) || typeof data.choices[0].message.role !== 'string' || !content(data.choices[0].message.content) || !content(data.choices[0].message.refusal) || !content(data.choices[0].message.reasoning_content) || !content(data.choices[0].message.reasoning) || !chatToolCalls(data.choices[0].message.tool_calls))
    throw { kind: 'unexpected_response', message: 'Pico /v1/chat/completions returned a 2xx body that is not a chat completion.' };
}
export function expectResponse(data) {
  if (!object(data) || !optionalFields(data, { id: responseTypes.string, model: responseTypes.string, status: responseTypes.string, created_at: responseTypes.number, completed_at: responseTypes.number, usage: responseUsage, error: responseTypes.object, incomplete_details: responseTypes.object }) || !Array.isArray(data.output) || !data.output.every(item => object(item) && typeof item.type === 'string' && parts(item.content) && parts(item.summary) && (item.type !== 'function_call' || typeof item.name === 'string' && typeof item.call_id === 'string' && typeof item.arguments === 'string' && optionalFields(item, { id: responseTypes.string, status: responseTypes.string })) && (item.type !== 'custom_tool_call' || typeof item.name === 'string' && typeof item.call_id === 'string' && typeof item.input === 'string' && optionalFields(item, { id: responseTypes.string, status: responseTypes.string }))))
    throw { kind: 'unexpected_response', message: 'Pico /v1/responses returned a 2xx body that is not a response.' };
}
export function expectOllamaChat(data) {
  if (!object(data) || !optionalFields(data, { model: responseTypes.string, created_at: responseTypes.string, done_reason: responseTypes.string, done: responseTypes.boolean, prompt_eval_count: responseTypes.number, eval_count: responseTypes.number, total_duration: responseTypes.number, load_duration: responseTypes.number, prompt_eval_duration: responseTypes.number, eval_duration: responseTypes.number }) || !object(data.message) || typeof data.message.role !== 'string' || typeof data.message.content !== 'string' || !content(data.message.thinking) || !ollamaToolCalls(data.message.tool_calls))
    throw { kind: 'unexpected_response', message: 'Pico /api/chat returned a 2xx body that is not an Ollama chat response.' };
}
export function errorData(error, config) {
  if (error?.source === 'pico') return { source: 'pico', status: error.status, body: error.body };
  if (!error?.kind) console.error(redact(error?.stack ?? String(error), config));
  const kind = error?.kind ?? 'internal_error';
  const message = error?.message ?? String(error);
  return { source: 'bridge', kind, message: kind === 'internal_error' ? redact(message, config) : message };
}
export function errorResult(error, config) {
  const data = errorData(error, config);
  const body = typeof data.body === 'string' ? data.body : JSON.stringify(data.body);
  const text = data.source === 'pico' ? `Pico AI Server returned HTTP ${data.status}: ${body}` : `Pico AI Bridge error (${data.kind}): ${data.message}`;
  return { content: [{ type: 'text', text }], structuredContent: data, isError: true };
}
export function splitThinking(content = '', enabled = true) {
  if (!enabled) return { answer: content, reasoning: '' };
  const blocks = [];
  let answer = String(content);
  const close = answer.indexOf('</think>');
  if (close !== -1 && !answer.slice(0, close).includes('<think>')) { blocks.push(answer.slice(0, close).trim()); answer = answer.slice(close + 8); }
  answer = answer.replace(/<think>([\s\S]*?)<\/think>/g, (_, text) => { blocks.push(text.trim()); return ''; });
  return { answer, reasoning: blocks.filter(Boolean).join('\n') };
}
export function parseArguments(value) {
  if (typeof value !== 'string') return value;
  try { const parsed = JSON.parse(value); return nonFiniteNumbers(parsed).length ? value : parsed; } catch { return value; }
}
export const milliseconds = nanoseconds => nanoseconds == null ? null : Math.round(nanoseconds / 1e6);
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.bmp': 'image/bmp', '.tiff': 'image/tiff' };
function ollamaImageData(uri) {
  try { uri = new URL(uri).href; } catch { throw { kind: 'invalid_arguments', message: 'Ollama image data URI is not a valid URL.' }; }
  const fragment = uri.indexOf('#');
  if (fragment !== -1) uri = uri.slice(0, fragment);
  uri = uri.slice(5);
  const comma = uri.indexOf(',');
  if (comma === -1) throw { kind: 'invalid_arguments', message: 'Ollama image data URI must contain a comma.' };
  const data = uri.slice(comma + 1);
  const bytes = Buffer.concat([...data.matchAll(/%[0-9a-f]{2}|[^%]+|%/gi)].map(([part]) => /^%[0-9a-f]{2}$/i.test(part) ? Buffer.from([Number.parseInt(part.slice(1), 16)]) : Buffer.from(part, 'latin1')));
  if (!/; *base64$/i.test(uri.slice(0, comma).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ''))) return bytes.toString('base64');
  let base64 = bytes.toString('latin1').replace(/[\t\n\f\r ]/g, '');
  if (base64.length % 4 === 0) base64 = base64.replace(/={1,2}$/, '');
  if (base64.length % 4 === 1) throw { kind: 'invalid_arguments', message: 'Ollama image data URI has invalid base64 length.' };
  if (/[^A-Za-z0-9+/]/.test(base64)) throw { kind: 'invalid_arguments', message: 'Ollama image data URI has an invalid base64 character or padding.' };
  return Buffer.from(base64, 'base64').toString('base64');
}
export async function imageDataUri(source, config) {
  if (/^(data:|https?:\/\/)/i.test(source)) return source;
  const path = source === '~' ? homedir() : source.startsWith('~/') ? join(homedir(), source.slice(2)) : source;
  try {
    const bytes = await readFile(path);
    return `data:${mime[extname(path).toLowerCase()] ?? 'application/octet-stream'};base64,${bytes.toString('base64')}`;
  } catch (error) { throw { kind: 'image_read_failed', message: `Could not read image ${path}: ${redact(String(error.code ?? error.message ?? error), config)}` }; }
}
export async function messagesFor(args, style, config) {
  if (style === 'responses' && typeof args.input === 'string' && !args.images?.length) return args.input;
  const source = style === 'responses' ? args.input : args.messages;
  const messages = Array.isArray(source) && (source.length || !args.images?.length) ? source.map(m => ({ ...m })) : args.system !== undefined && args.prompt === undefined && !args.images?.length && style !== 'responses' ? [] : [{ role: 'user', content: args.prompt ?? args.input ?? '' }];
  if (args.system !== undefined && style !== 'responses') messages.unshift({ role: 'system', content: args.system });
  if (args.images?.length) {
    const target = [...messages].reverse().find(m => m.role === 'user');
    if (!target || typeof target.content !== 'string' && !Array.isArray(target.content)) throw { kind: 'invalid_arguments', message: 'Images require a user message with string or array content.' };
    if (style === 'ollama' && Object.hasOwn(target, 'images') && !Array.isArray(target.images)) throw { kind: 'invalid_arguments', message: 'Images require the user message images field to be an array.' };
    const images = await Promise.all(args.images.map(source => imageDataUri(source, config)));
    if (style === 'ollama') target.images = [...(target.images ?? []), ...images.map(i => {
      if (!/^data:/i.test(i)) return i;
      return ollamaImageData(i);
    })];
    else {
      const content = Array.isArray(target.content) ? [...target.content] : [];
      if (typeof target.content === 'string' && (target.content || args.prompt !== undefined || typeof args.input === 'string' || Array.isArray(source) && source.length > 0)) content.push({ type: style === 'responses' ? 'input_text' : 'text', text: target.content });
      target.content = style === 'responses'
        ? [...content, ...images.map(image_url => ({ type: 'input_image', image_url }))]
        : [...content, ...images.map(url => ({ type: 'image_url', image_url: { url } }))];
    }
  }
  return messages;
}
export const imagesProperty = { type: 'array', items: { type: 'string' }, description: 'An entry starting with data:, http://, or https:// (ASCII case-insensitive, no leading whitespace) is a URI; anything else is a local file path. `~` and paths starting with `~/` resolve against the bridge process home directory; other paths are used as given (relative paths resolve against its working directory). Local files are read without image checks; URLs are not fetched.' };
export const common = { raw: { type: 'boolean', default: false, description: 'Return the HTTP status and parsed Pico body (text when not JSON), with the configured API key redacted in body values and keys.' }, split_thinking: { type: 'boolean', default: true, description: 'Move <think> blocks into reasoning in default mode.' }, extra: { type: 'object', description: 'Additional top-level Pico request fields. Keys already sent by other arguments are rejected.' } };
export const getCommon = { raw: common.raw };
export function checkExtra(keys, args, hints = {}) {
  const conflicts = Object.keys(args.extra ?? {}).filter(key => keys.includes(key));
  const argument = key => typeof hints[key] === 'function' ? hints[key](args) : hints[key] ?? `use ${key}`;
  if (conflicts.length) throw { kind: 'invalid_arguments', message: `extra conflicts with ${conflicts.map(key => `${key} (${argument(key)})`).join(', ')}.` };
}
export function mergeExtra(body, args) {
  return { ...body, ...(args.extra ?? {}) };
}
export const missingInput = message => { throw { kind: 'invalid_arguments', message }; };
