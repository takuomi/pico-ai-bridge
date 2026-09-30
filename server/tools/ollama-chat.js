import { checkExtra, common, expectOllamaChat, imagesProperty, messagesFor, mergeExtra, missingInput, milliseconds, parseArguments, rawResult, redact, redactPicoData, result, splitThinking } from '../core/util.js';
const extraHints = { messages: 'use prompt or messages', options: 'use options', stream: 'stream is fixed to false' };
export const tool = {
  name: 'pico_ollama_chat', title: 'Pico Ollama chat',
  description: 'Ollama chat: send optional prompt, messages, images or system, plus format, options and keep_alive. Absent `messages` are omitted from the request. Default mode extracts the message; raw returns Pico HTTP status and parsed body.',
  inputSchema: { type: 'object', properties: { ...common,
    model: { type: 'string', description: 'Model name; if omitted, Pico chooses its default model.' }, prompt: { type: 'string', description: 'User prompt converted to an Ollama chat message.' }, messages: { type: 'array', items: { type: 'object' }, description: 'Ollama message objects sent as given; an empty array is allowed.' }, system: { type: 'string', description: 'System instruction added as a system message.' }, images: imagesProperty, think: { type: 'boolean', description: 'Ollama think boolean. extra.think sends a level string or null unchanged; the tested Pico server accepted null and rejected level strings.' },
    format: { type: ['string', 'object'], description: 'Ollama format string or JSON schema object, sent as given; Ollama documents "json" as the string value, and the tested Pico server accepted "json" and rejected schema objects.' }, options: { type: 'object', description: 'Ollama options object sent as given.' }, keep_alive: { type: ['string', 'number'], description: 'Keep the model loaded for this duration or number of seconds.' }, tools: { type: 'array', items: { type: 'object' }, description: 'Tool definitions in the Ollama API format.' }
  }, additionalProperties: false },
  annotations: { title: 'Pico Ollama chat', readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  async handler(args, ctx) {
    if (args.prompt !== undefined && args.messages !== undefined) missingInput('Provide either prompt or messages, not both.');
    const body = { ...(args.model === undefined ? {} : { model: args.model }), stream: false };
    if (args.prompt !== undefined || args.messages !== undefined || args.images?.length || args.system !== undefined) body.messages = null;
    for (const key of ['think', 'format', 'options', 'keep_alive', 'tools']) if (args[key] !== undefined) body[key] = args[key];
    checkExtra(Object.keys(body), args, extraHints);
    if (Object.hasOwn(body, 'messages')) body.messages = await messagesFor(args, 'ollama', ctx.config);
    const response = await ctx.request('/api/chat', { method: 'POST', body: mergeExtra(body, args), allowText: args.raw });
    if (args.raw) return rawResult(response, ctx.config);
    const data = response.body;
    expectOllamaChat(data);
    const message = data?.message ?? {};
    const split = splitThinking(message.content ?? '', args.split_thinking !== false);
    const tool_calls = (message.tool_calls ?? []).map(item => ({ ...redact({ id: item.id ?? null, name: item.function?.name }, ctx.config), arguments: redactPicoData(parseArguments(item.function?.arguments ?? null), ctx.config) }));
    return result({ ...redact({ answer: split.answer, reasoning: [split.reasoning, message.thinking].filter(Boolean).join('\n'),
      usage: { prompt_eval_count: data?.prompt_eval_count ?? null, eval_count: data?.eval_count ?? null },
      durations_ms: { total: milliseconds(data?.total_duration), load: milliseconds(data?.load_duration), prompt_eval: milliseconds(data?.prompt_eval_duration), eval: milliseconds(data?.eval_duration) },
      finish_reason: data?.done_reason ?? null, response_model: data?.model ?? null, created_at: data?.created_at ?? null, done: data?.done ?? null }, ctx.config), tool_calls });
  }
};
