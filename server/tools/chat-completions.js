import { chatCalls, checkExtra, common, expectChatCompletion, imagesProperty, messagesFor, mergeExtra, missingInput, rawResult, redact, redactPicoData, result, splitThinking } from '../core/util.js';
const extraHints = { messages: 'use prompt or messages', reasoning_effort: 'use reasoning_effort', response_format: 'use response_format', stream: 'stream is fixed to false' };
export const tool = {
  name: 'pico_chat_completions', title: 'Pico chat completions',
  description: 'Chat completions: send prompt, messages, images or system, plus optional response_format and tools. Default mode extracts the first choice; raw returns Pico HTTP status and parsed body.',
  inputSchema: { type: 'object', properties: { ...common,
    model: { type: 'string', description: 'Model name; if omitted, Pico chooses its default model.' }, prompt: { type: 'string', description: 'User prompt converted to a chat message.' }, messages: { type: 'array', items: { type: 'object' }, description: 'Chat message objects sent as given.' }, system: { type: 'string', description: 'System instruction added as a system message.' }, images: imagesProperty,
    temperature: { type: 'number' }, top_p: { type: 'number' }, frequency_penalty: { type: 'number' }, max_tokens: { type: 'integer', description: 'Maximum number of completion tokens.' },
    reasoning_effort: { type: 'string', description: 'Sent as reasoning_effort.' }, response_format: { type: 'object', description: 'Response format object sent as given.' }, tools: { type: 'array', items: { type: 'object' }, description: 'Tool definitions in the chat completions API format.' }, tool_choice: { type: ['string', 'object'], description: 'Tool choice sent as given.' }
  }, additionalProperties: false },
  annotations: { title: 'Pico chat completions', readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  async handler(args, ctx) {
    if (args.prompt !== undefined && args.messages !== undefined) missingInput('Provide either prompt or messages, not both.');
    if (args.prompt === undefined && args.messages === undefined && args.extra?.messages === undefined && args.system === undefined && !args.images?.length) missingInput('Provide prompt, messages, images or system.');
    const body = { ...(args.model === undefined ? {} : { model: args.model }), stream: false };
    if (args.prompt !== undefined || args.messages !== undefined || args.images?.length || args.system !== undefined) body.messages = null;
    for (const key of ['temperature', 'top_p', 'frequency_penalty', 'tool_choice', 'response_format']) if (args[key] !== undefined) body[key] = args[key];
    if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;
    if (args.reasoning_effort !== undefined) body.reasoning_effort = args.reasoning_effort;
    if (args.tools) body.tools = args.tools;
    checkExtra(Object.keys(body), args, extraHints);
    if (Object.hasOwn(body, 'messages')) body.messages = await messagesFor(args, 'chat', ctx.config);
    const response = await ctx.request('/v1/chat/completions', { method: 'POST', body: mergeExtra(body, args), allowText: args.raw });
    if (args.raw) return rawResult(response, ctx.config);
    const data = response.body;
    expectChatCompletion(data);
    const choice = data?.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const split = splitThinking(message.content ?? '', args.split_thinking !== false);
    const tool_calls = chatCalls(message.tool_calls, ctx.config);
    return result({ ...redact({ answer: split.answer, refusal: message.refusal ?? null, reasoning: [split.reasoning, message.reasoning_content, message.reasoning].filter(Boolean).join('\n'), finish_reason: choice.finish_reason ?? null, response_id: data?.id ?? null, response_model: data?.model ?? null, created: data?.created ?? null }, ctx.config), usage: redactPicoData(data?.usage ?? null, ctx.config), tool_calls });
  }
};
