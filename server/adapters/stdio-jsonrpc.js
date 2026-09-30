import { createInterface } from 'node:readline';
import { callTool, createContext, publicTools } from '../core/registry.js';
import { readConfig } from '../core/config.js';
import { redact } from '../core/util.js';

export const legacyVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const modernVersion = '2026-07-28';
const batchVersions = new Set(['2025-03-26', '2024-11-05']);
const versionKey = 'io.modelcontextprotocol/protocolVersion';
const capabilitiesKey = 'io.modelcontextprotocol/clientCapabilities';
const serverInfoKey = 'io.modelcontextprotocol/serverInfo';
const subscriptionKey = 'io.modelcontextprotocol/subscriptionId';
const cache = { ttlMs: 300000, cacheScope: 'public' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value);
const validClientInfo = metadata => metadata['io.modelcontextprotocol/clientInfo'] === undefined ||
  (object(metadata['io.modelcontextprotocol/clientInfo']) &&
    typeof metadata['io.modelcontextprotocol/clientInfo'].name === 'string' &&
    typeof metadata['io.modelcontextprotocol/clientInfo'].version === 'string');
const error = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

/** Serve both MCP eras over newline-delimited stdio without runtime packages. */
export function startStdioJsonRpc({ info, tools = publicTools(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, config = readConfig() }) {
  const ctx = createContext(config);
  const toolNames = new Set(tools.map(tool => tool.name));
  const identity = { [serverInfoKey]: { name: info.name, version: info.version } };
  const subscriptions = new Set();
  const inFlight = new Map();
  const cancelled = new Set();
  let initialized = false;
  let negotiatedLegacyVersion;
  const send = message => stdout.write(`${JSON.stringify(message)}\n`);
  const result = (id, body, isModern) => ({
    jsonrpc: '2.0', id,
    result: isModern ? { resultType: 'complete', ...body, _meta: identity } : body
  });

  async function dispatch(request) {
    if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
        ('id' in request && !validId(request.id))) {
      return error(object(request) && validId(request.id) ? request.id : null, -32600, 'Invalid Request');
    }
    if ('params' in request && !object(request.params)) return 'id' in request ? error(request.id, -32602, 'Invalid params') : null;
    const { id, method, params = {} } = request;
    if (!('id' in request)) {
      if (method === 'notifications/cancelled' && validId(params.requestId)) {
        subscriptions.delete(params.requestId);
        if (inFlight.has(params.requestId)) { inFlight.get(params.requestId).abort(); cancelled.add(params.requestId); }
      }
      return null;
    }
    if (Object.hasOwn(params, '_meta') && !object(params._meta)) return error(id, -32602, 'Invalid params');
    const metadata = params._meta;
    const hasModernClaim = object(metadata) && versionKey in metadata;
    if (method === 'initialize') {
      if (object(params._meta) && versionKey in params._meta) {
        const requested = params._meta[versionKey];
        if (typeof requested === 'string' && requested !== modernVersion) {
          return error(id, -32022, 'Unsupported protocol version', { supported: [modernVersion], requested });
        }
        if (requested !== modernVersion || !object(params._meta[capabilitiesKey]) || !validClientInfo(params._meta)) {
          return error(id, -32602, 'Invalid modern request metadata');
        }
        return error(id, -32601, 'Method not found: initialize');
      }
      if (typeof params.protocolVersion !== 'string' || !object(params.capabilities) ||
          !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        return error(id, -32602, 'Invalid initialize params');
      }
      initialized = true;
      const protocolVersion = legacyVersions.includes(params.protocolVersion) ? params.protocolVersion : legacyVersions[0];
      negotiatedLegacyVersion = protocolVersion;
      return result(id, { protocolVersion, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version }, instructions: info.instructions }, false);
    }

    if (hasModernClaim && typeof metadata[versionKey] === 'string' && metadata[versionKey] !== modernVersion) {
      return error(id, -32022, 'Unsupported protocol version', {
        supported: [modernVersion], requested: metadata[versionKey]
      });
    }
    if (hasModernClaim || method === 'server/discover') {
      if (!object(metadata) || metadata[versionKey] !== modernVersion || !object(metadata[capabilitiesKey]) || !validClientInfo(metadata)) {
        return error(id, -32602, 'Invalid modern request metadata');
      }
    }
    const isModern = hasModernClaim;
    if (method === 'server/discover') {
      return result(id, { supportedVersions: [modernVersion], capabilities: { tools: { listChanged: false } },
        instructions: info.instructions, ...cache }, true);
    }
    if (method === 'ping') return isModern ? error(id, -32601, 'Method not found: ping') : result(id, {}, false);
    if (!initialized && !isModern) return error(id, -32602, 'Initialize the MCP connection or provide modern request metadata');
    if (method === 'subscriptions/listen' && isModern) {
      if (!object(params.notifications) ||
          ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged'].some(key => params.notifications[key] !== undefined && typeof params.notifications[key] !== 'boolean') ||
          (params.notifications.resourceSubscriptions !== undefined &&
            (!Array.isArray(params.notifications.resourceSubscriptions) || !params.notifications.resourceSubscriptions.every(uri => typeof uri === 'string')))) {
        return error(id, -32602, 'Invalid subscriptions/listen params');
      }
      subscriptions.add(id);
      send({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged',
        params: { _meta: { [subscriptionKey]: id }, notifications: {} } });
      return null;
    }
    if (method === 'tools/list') {
      if (params.cursor !== undefined) return error(id, -32602, 'Invalid tools/list cursor');
      return result(id, isModern ? { tools, ...cache } : { tools }, isModern);
    }
    if (method === 'tools/call') {
      if (typeof params.name !== 'string' || (params.arguments !== undefined && !object(params.arguments))) {
        return error(id, -32602, 'Invalid tools/call params');
      }
      if (!toolNames.has(params.name)) return error(id, -32602, `Unknown tool: ${params.name}`);
      const controller = new AbortController();
      inFlight.set(id, controller);
      try {
        const response = await callTool(params.name, params.arguments ?? {}, ctx, { signal: controller.signal });
        return cancelled.has(id) ? null : result(id, response, isModern);
      } catch (cause) { if (cancelled.has(id)) return null; throw cause; }
      finally { inFlight.delete(id); cancelled.delete(id); }
    }
    return error(id, -32601, `Method not found: ${method}`);
  }

  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  async function handleLine(line) {
    let request;
    try { request = JSON.parse(line); } catch { send(error(null, -32700, 'Parse error')); return; }
    if (Array.isArray(request) && batchVersions.has(negotiatedLegacyVersion)) {
      if (!request.length) { send(error(null, -32600, 'Invalid Request')); return; }
      const responses = await Promise.all(request.map(async item => {
        if (object(item) && (item.method === 'server/discover' ||
            object(item.params?._meta) && versionKey in item.params._meta)) {
          return 'id' in item ? error(validId(item.id) ? item.id : null, -32600, 'Invalid Request') : null;
        }
        if (object(item) && item.method === 'initialize' && 'id' in item) {
          return error(validId(item.id) ? item.id : null, -32600, 'Invalid Request');
        }
        try { return await dispatch(item); }
        catch (cause) {
          stderr.write(`pico-ai-bridge: ${redact(String(cause?.stack ?? cause), config)}\n`);
          return error(object(item) && validId(item.id) ? item.id : null, -32603, 'Internal error');
        }
      }));
      if (responses.some(Boolean)) send(responses.filter(Boolean));
      return;
    }
    try { const response = await dispatch(request); if (response) send(response); }
    catch (cause) {
      stderr.write(`pico-ai-bridge: ${redact(String(cause?.stack ?? cause), config)}\n`);
      send(error(request?.id ?? null, -32603, 'Internal error'));
    }
  }
  lines.on('line', handleLine);
  lines.on('close', () => {
    for (const id of subscriptions) send({ jsonrpc: '2.0', id,
      result: { resultType: 'complete', _meta: { ...identity, [subscriptionKey]: id } } });
    subscriptions.clear();
  });
  return { dispatch, handleLine, close: () => lines.close() };
}
