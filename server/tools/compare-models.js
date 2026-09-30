import { chatCalls, checkExtra, common, customToolCalls, errorData, expectChatCompletion, expectOllamaChat, expectResponse, imagesProperty, mergeExtra, messagesFor, milliseconds, parseArguments, reasoningParts, redact, redactPicoData, responseRefusal, result, splitThinking } from '../core/util.js';
const calls = (items, config, fields) => (items ?? []).map(item => ({ ...redact(Object.fromEntries(fields.map(([key, value]) => [key, value(item)])), config), arguments: redactPicoData(parseArguments(item.function ? item.function.arguments ?? null : item.arguments), config) }));
const extraHints = { model: 'use models', input: 'use prompt or messages', messages: 'use prompt or messages', instructions: 'use system',
  options: 'use options, max_tokens or temperature',
  reasoning: 'use reasoning', reasoning_effort: 'use reasoning', think: 'use think', max_tokens: 'use max_tokens', max_output_tokens: 'use max_tokens', stream: 'stream is fixed to false' };
export const tool = {
  name: 'pico_compare_models', title: 'Compare Pico models',
  description: "Compare two or more models sequentially through the selected API. Provide prompt, messages, or images alone; with the Responses API, messages are sent as input. Each row includes elapsed_ms and either extracted output, Pico HTTP status and parsed body in raw mode, or an error.",
  inputSchema: { type: 'object', properties: { ...common,
    models: { type: 'array', items: { type: 'string' }, minItems: 2, description: 'Two or more model names to run sequentially.' }, prompt: { type: 'string', description: 'User prompt converted to the selected API message or input.' }, messages: { type: 'array', items: { type: 'object' }, description: 'Message objects for the selected API; Responses sends them as input.' }, system: { type: 'string', description: 'System message, or Responses instructions.' }, images: imagesProperty,
    api: { type: 'string', enum: ['responses', 'chat_completions', 'ollama'], default: 'chat_completions', description: 'API used for every model comparison.' }, max_tokens: { type: 'integer', description: 'Maximum tokens; maps to max_output_tokens for Responses, num_predict in Ollama options, or max_tokens for chat completions.' }, temperature: { type: 'number', description: 'Sampling temperature; maps to Ollama options.temperature or the top-level temperature for Responses and chat completions.' }, reasoning: { type: 'string', description: 'Reasoning effort for Responses or chat_completions; unavailable with Ollama.' }, think: { type: 'boolean', description: 'Ollama think boolean; available only with Ollama. extra.think sends a level string or null unchanged; the tested Pico server accepted null and rejected level strings.' }, options: { type: 'object', description: 'Ollama options object; available only with Ollama.' }
  }, required: ['models'], additionalProperties: false },
  annotations: { title: 'Compare Pico models', readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  async handler(args, ctx) {
    if (args.prompt !== undefined && args.messages !== undefined) throw { kind: 'invalid_arguments', message: 'Provide either prompt or messages, not both.' };
    if (args.prompt === undefined && args.messages === undefined && !args.images?.length) throw { kind: 'invalid_arguments', message: 'Provide prompt, messages or images.' };
    const api = args.api ?? 'chat_completions';
    if (api === 'ollama' && args.reasoning !== undefined) throw { kind: 'invalid_arguments', message: 'reasoning applies to responses and chat_completions; use think for ollama.' };
    if (api !== 'ollama' && args.think !== undefined) throw { kind: 'invalid_arguments', message: 'think applies only to the ollama api; use reasoning.' };
    if (api !== 'ollama' && args.options !== undefined) throw { kind: 'invalid_arguments', message: 'options applies only to the ollama api.' };
    for (const [key, argument] of [['num_predict', 'max_tokens'], ['temperature', 'temperature']])
      if (api === 'ollama' && args.options && Object.hasOwn(args.options, key) && args[argument] !== undefined)
        throw { kind: 'invalid_arguments', message: `options.${key} conflicts with ${argument}.` };
    let path, body;
    if (api === 'responses') {
      path = '/v1/responses'; body = { model: null, input: args.messages ?? args.prompt ?? null, stream: false };
      if (args.system !== undefined) body.instructions = args.system;
      if (args.max_tokens !== undefined) body.max_output_tokens = args.max_tokens;
      if (args.reasoning !== undefined) body.reasoning = { effort: args.reasoning };
    } else if (api === 'ollama') {
      path = '/api/chat'; body = { model: null, messages: null, stream: false };
      if (args.options !== undefined) body.options = { ...args.options };
      if (args.max_tokens !== undefined) (body.options ??= {}).num_predict = args.max_tokens;
      if (args.think !== undefined) body.think = args.think;
    } else {
      path = '/v1/chat/completions'; body = { model: null, messages: null, stream: false };
      if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
      if (args.reasoning !== undefined) body.reasoning_effort = args.reasoning;
    }
    if (args.temperature !== undefined) (api === 'ollama' ? (body.options ??= {}) : body).temperature = args.temperature;
    checkExtra(Object.keys(body), args, extraHints);
    if (api === 'responses' && args.images?.length) body.input = await messagesFor({ ...args, input: args.messages ?? args.prompt }, 'responses', ctx.config);
    else if (api !== 'responses') body.messages = await messagesFor(args, api === 'ollama' ? 'ollama' : 'chat', ctx.config);
    const rows = [];
    for (const model of args.models) {
      if (ctx.signal?.aborted) throw { kind: 'cancelled', message: 'Request cancelled before it was sent to Pico.' };
      const start = performance.now();
      try {
        body.model = model;
        const response = await ctx.request(path, { method: 'POST', body: mergeExtra(body, args), allowText: args.raw });
        if (args.raw) rows.push({ model, status: response.status, body: redactPicoData(response.body, ctx.config), elapsed_ms: Math.round(performance.now() - start) });
        else {
          const data = response.body;
          if (api === 'responses') expectResponse(data);
          else if (api === 'ollama') expectOllamaChat(data);
          else expectChatCompletion(data);
          const text = api === 'responses' ? (data.output ?? []).flatMap(x => x.content ?? []).filter(x => x.type === 'output_text').map(x => x.text ?? '').join('')
            : api === 'ollama' ? data.message?.content ?? '' : data.choices?.[0]?.message?.content ?? '';
          const split = splitThinking(text, args.split_thinking !== false);
          const reasoning = api === 'responses' ? (data.output ?? []).filter(item => item.type === 'reasoning').flatMap(reasoningParts).map(part => part.text ?? '').join('\n')
            : api === 'ollama' ? data.message?.thinking : [data.choices?.[0]?.message?.reasoning_content, data.choices?.[0]?.message?.reasoning].filter(Boolean).join('\n');
          const choice = data.choices?.[0] ?? {};
          const output = data.output ?? [];
          const details = api === 'responses' ? {
            function_calls: calls(output.filter(item => item.type === 'function_call'), ctx.config, [['id', item => item.id ?? null], ['call_id', item => item.call_id ?? null], ['name', item => item.name], ['status', item => item.status ?? null]]),
            custom_tool_calls: customToolCalls(output, ctx.config),
            status: redact(data.status ?? null, ctx.config), error: redactPicoData(data.error ?? null, ctx.config), incomplete_details: redactPicoData(data.incomplete_details ?? null, ctx.config)
          } : api === 'ollama' ? {
            tool_calls: calls(data.message?.tool_calls, ctx.config, [['id', item => item.id ?? null], ['name', item => item.function?.name]]),
            finish_reason: redact(data.done_reason ?? null, ctx.config)
          } : {
            tool_calls: chatCalls(choice.message?.tool_calls, ctx.config),
            finish_reason: redact(choice.finish_reason ?? null, ctx.config)
          };
          rows.push({ model, ...redact({ answer: split.answer, ...(api === 'ollama' ? {} : { refusal: api === 'responses' ? responseRefusal(output) : choice.message?.refusal ?? null }), reasoning: [split.reasoning, reasoning].filter(Boolean).join('\n'), response_model: data.model ?? null,
            ...(api === 'ollama' ? { durations_ms: { total: milliseconds(data.total_duration), load: milliseconds(data.load_duration), prompt_eval: milliseconds(data.prompt_eval_duration), eval: milliseconds(data.eval_duration) }, created_at: data.created_at ?? null, done: data.done ?? null } : api === 'responses' ? { response_id: data.id ?? null, created_at: data.created_at ?? null, completed_at: data.completed_at ?? null } : { response_id: data.id ?? null, created: data.created ?? null }) }, ctx.config),
            ...details, ...(api === 'ollama' ? { usage: redactPicoData({ prompt_eval_count: data.prompt_eval_count ?? null, eval_count: data.eval_count ?? null }, ctx.config) } : data.usage ? { usage: redactPicoData(data.usage, ctx.config) } : {}), elapsed_ms: Math.round(performance.now() - start) });
        }
      } catch (error) {
        if (error?.kind === 'cancelled') throw error;
        rows.push({ model, elapsed_ms: Math.round(performance.now() - start), error: errorData(error, ctx.config) });
        if (error?.kind === 'timeout' && error.settled) {
          if (ctx.signal?.aborted) throw { kind: 'cancelled', message: 'Request cancelled before the next model was sent to Pico.' };
          if (!ctx.signal) await error.settled;
          else {
            let onAbort;
            try { await Promise.race([error.settled, new Promise(resolve => { onAbort = resolve; ctx.signal.addEventListener('abort', onAbort, { once: true }); })]); }
            finally { ctx.signal.removeEventListener('abort', onAbort); }
            if (ctx.signal.aborted) throw { kind: 'cancelled', message: 'Request cancelled before the next model was sent to Pico.' };
          }
        }
      }
    }
    return result({ api, results: rows });
  }
};
