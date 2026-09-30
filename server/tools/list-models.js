import { getCommon, optionalFields, redactPicoData, responseTypes, result } from '../core/util.js';
export const tool = {
  name: 'pico_list_models', title: 'List Pico models',
  description: 'Merge /v1/models and /api/tags by model name, treating names without a tag as :latest; optionally call /api/show once per model. Raw mode returns endpoint status and body pairs.',
  inputSchema: { type: 'object', properties: { ...getCommon, include_capabilities: { type: 'boolean', default: false, description: 'Call /api/show once per merged model and add its capabilities and context_length.' } }, additionalProperties: false },
  annotations: { title: 'List Pico models', readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  async handler(args, ctx) {
    const settle = async request => { try { return await request(); } catch (error) { if (error?.source === 'pico') return { status: error.status, body: error.body }; throw error; } };
    const cleanResponse = response => response.status >= 200 && response.status < 300 ? { ...response, body: redactPicoData(response.body, ctx.config) } : response;
    const openai = await settle(() => ctx.request('/v1/models', { allowText: args.raw }));
    const ollama = await settle(() => ctx.request('/api/tags', { allowText: args.raw }));
    if (args.raw && !args.include_capabilities) return { ...result({ v1_models: cleanResponse(openai), api_tags: cleanResponse(ollama) }), ...(openai.status >= 300 || ollama.status >= 300 ? { isError: true } : {}) };
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const tagged = name => /:[^/]*$/.test(name) ? name : `${name}:latest`;
    for (const [path, response, key, valid] of [
      ['/v1/models', openai, 'data', item => typeof item.id === 'string' && (args.raw || optionalFields(item, { status: object, created: responseTypes.number, owned_by: responseTypes.string }) && (item.status == null || item.status.value == null || typeof item.status.value === 'string'))],
      ['/api/tags', ollama, 'models', item => typeof item.name === 'string' && (args.raw || optionalFields(item, { model: responseTypes.string, size: responseTypes.number, modified_at: responseTypes.string, details: object }) && (item.details == null || optionalFields(item.details, { format: responseTypes.string, family: responseTypes.string, parameter_size: responseTypes.string, quantization_level: responseTypes.string })))]
    ]) if (response.status >= 200 && response.status < 300 && (!object(response.body) || !Array.isArray(response.body[key]) || !response.body[key].every(item => object(item) && valid(item))))
      throw { kind: 'unexpected_response', message: `Pico ${path} returned a 2xx body that is not a model list.` };
    if (!args.raw && openai.status < 300 && openai.body.models != null && (!Array.isArray(openai.body.models) || !openai.body.models.every(item => object(item) && optionalFields(item, { model: responseTypes.string, name: responseTypes.string }))))
      throw { kind: 'unexpected_response', message: 'Pico /v1/models returned a 2xx body that is not a model list.' };
    const models = new Map();
    for (const item of openai.status < 300 ? openai.body.data : []) models.set(tagged(item.id), {
      id: item.id, name: null, display_name: !args.raw ? openai.body.models?.find(model => model.model === item.id)?.name ?? null : null,
      tag_model: null, status: !args.raw ? item.status?.value ?? null : null, created: item.created ?? null, owned_by: item.owned_by ?? null, format: null, family: null, parameter_size: null,
      quantization_level: null, size_bytes: null, size_gb: null, modified_at: null
    });
    for (const item of ollama.status < 300 ? ollama.body.models : []) {
      const details = args.raw ? {} : item.details ?? {};
      const key = tagged(item.name);
      models.set(key, { ...(models.get(key) ?? { id: null, name: null, display_name: null, tag_model: null, status: null, created: null, owned_by: null }),
        name: item.name, tag_model: item.model ?? null, format: details.format ?? null, family: details.family ?? null,
        parameter_size: details.parameter_size ?? null, quantization_level: details.quantization_level ?? null,
        size_bytes: item.size ?? null, size_gb: !args.raw && item.size != null ? Number((item.size / 1e9).toFixed(2)) : null,
        modified_at: item.modified_at ?? null });
    }
    const shows = Object.create(null);
    if (args.include_capabilities) for (const model of models.values()) {
      const name = model.name ?? model.id;
      const shown = await settle(() => ctx.request('/api/show', { method: 'POST', body: { model: name }, allowText: args.raw }));
      shows[name] = shown;
      if (shown.status >= 300) model.capabilities_error = { source: 'pico', status: shown.status, body: shown.body };
      else {
        if (!args.raw && !object(shown.body)) throw { kind: 'unexpected_response', message: 'Pico /api/show returned a 2xx body that is not an object.' };
        if (!args.raw && (shown.body.capabilities != null && (!Array.isArray(shown.body.capabilities) || !shown.body.capabilities.every(value => typeof value === 'string')) ||
            shown.body.model_info != null && !object(shown.body.model_info)))
          throw { kind: 'unexpected_response', message: 'Pico /api/show returned a 2xx body with invalid capabilities or model_info.' };
        if (!args.raw && Object.entries(shown.body.model_info ?? {}).some(([key, value]) => key.endsWith('.context_length') && value != null && (typeof value !== 'number' || !Number.isFinite(value))))
          throw { kind: 'unexpected_response', message: 'Pico /api/show returned a 2xx body with invalid context_length.' };
        model.capabilities = shown.body?.capabilities ?? null;
        model.context_length = Object.entries(shown.body?.model_info ?? {}).find(([key]) => key.endsWith('.context_length'))?.[1] ?? null;
      }
    }
    const errors = [['/v1/models', openai], ['/api/tags', ollama]].filter(([, response]) => response.status >= 300)
      .map(([path, response]) => ({ path, error: { source: 'pico', status: response.status, body: response.body } }));
    if (args.raw) return { ...result({ v1_models: cleanResponse(openai), api_tags: cleanResponse(ollama), ...(args.include_capabilities ? { api_show: Object.fromEntries(Object.entries(shows).map(([id, response]) => [redactPicoData(id, ctx.config), cleanResponse(response)])) } : {}) }),
      ...(errors.length || Object.values(shows).some(response => response.status >= 300) ? { isError: true } : {}) };
    if (errors.length === 2) {
      const data = { models: [], partial_errors: errors };
      const text = errors.map(item => `Pico AI Server returned HTTP ${item.error.status}: ${typeof item.error.body === 'string' ? item.error.body : JSON.stringify(item.error.body)} (${item.path})`).join('\n');
      return { content: [{ type: 'text', text }], structuredContent: data, isError: true };
    }
    return result({ models: [...models.values()].map(model => {
      const { capabilities_error, ...fields } = model;
      return { ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redactPicoData(value, ctx.config)])), ...(capabilities_error ? { capabilities_error } : {}) };
    }), partial_errors: errors });
  }
};
