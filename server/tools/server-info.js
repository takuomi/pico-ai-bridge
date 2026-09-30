import { getCommon, optionalFields, rawResult, redactPicoData, responseTypes, result } from '../core/util.js';
export const tool = {
  name: 'pico_server_info', title: 'Pico server information',
  description: 'Read /api/version for connectivity, name, version, build and bundle_identifier; raw mode returns HTTP status and parsed body.',
  inputSchema: { type: 'object', properties: getCommon, additionalProperties: false },
  annotations: { title: 'Pico server information', readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  async handler(args, ctx) {
    const response = await ctx.request('/api/version', { allowText: args.raw });
    if (args.raw) return rawResult(response, ctx.config);
    const data = response.body;
    if (data === null || typeof data !== 'object' || Array.isArray(data) || !optionalFields(data, { version: responseTypes.string, name: responseTypes.string, build: responseTypes.string, bundle_identifier: responseTypes.string })) throw { kind: 'unexpected_response', message: 'Pico /api/version returned a 2xx body that is not server version information.' };
    const version = data.version ?? null;
    return result({ reachable: true, base_url: ctx.config.baseUrl, version: redactPicoData(version, ctx.config), name: redactPicoData(data.name ?? null, ctx.config), build: redactPicoData(data.build ?? null, ctx.config), bundle_identifier: redactPicoData(data.bundle_identifier ?? null, ctx.config) });
  }
};
