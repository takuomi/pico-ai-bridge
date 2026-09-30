import { checkExtra, common, customToolCalls, expectResponse, imagesProperty, messagesFor, mergeExtra, parseArguments, rawResult, reasoningParts, redact, redactPicoData, responseRefusal, result, splitThinking } from '../core/util.js';
const extraHints = { input: 'use input', text: 'use json_schema and json_schema_name', reasoning: 'use reasoning_effort', stream: 'stream is fixed to false' };
export const tool = {
  name: 'pico_responses', title: 'Pico Responses API',
  description: 'Responses API: send optional string or item-array input, instructions, JSON schema and tool definitions as given. An absent `input` is omitted from the request. Default mode returns output and function and custom calls; raw returns Pico HTTP status and parsed body.',
  inputSchema: { type: 'object', properties: { ...common,
    model: { type: 'string', description: 'Model name; if omitted, Pico chooses its default model.' }, input: { type: ['string', 'array'], items: { type: 'object' }, description: 'Optional Responses input string or item array sent as given; omitted when absent.' }, instructions: { type: 'string', description: 'Instructions sent in the Responses request.' }, images: imagesProperty,
    temperature: { type: 'number' }, top_p: { type: 'number' }, max_output_tokens: { type: 'integer', description: 'Maximum number of output tokens.' }, reasoning_effort: { type: 'string', description: 'Sent as reasoning.effort.' },
    json_schema: { type: 'object', description: 'Sent as text.format with type json_schema and this schema.' }, json_schema_name: { type: 'string', description: 'Name sent as text.format.name; required with json_schema by the Responses API.' }, tools: { type: 'array', items: { type: 'object' }, description: 'Tool definitions in the Responses API format.' }, tool_choice: { type: ['string', 'object'], description: 'Tool choice sent as given.' }, previous_response_id: { type: 'string', description: 'Prior response ID sent as given.' }
  }, additionalProperties: false },
  annotations: { title: 'Pico Responses API', readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  async handler(args, ctx) {
    if (args.json_schema !== undefined && args.json_schema_name === undefined) throw { kind: 'invalid_arguments', message: 'json_schema_name is required with json_schema.' };
    if (args.json_schema === undefined && args.json_schema_name !== undefined) throw { kind: 'invalid_arguments', message: 'json_schema is required with json_schema_name.' };
    const body = { ...(args.model === undefined ? {} : { model: args.model }), stream: false };
    if (args.input !== undefined || args.images?.length) body.input = args.input ?? null;
    for (const key of ['instructions', 'temperature', 'top_p', 'max_output_tokens', 'tool_choice', 'previous_response_id']) if (args[key] !== undefined) body[key] = args[key];
    if (args.reasoning_effort !== undefined) body.reasoning = { effort: args.reasoning_effort };
    if (args.json_schema !== undefined) body.text = { format: { type: 'json_schema', name: args.json_schema_name, schema: args.json_schema } };
    if (args.tools) body.tools = args.tools;
    checkExtra(Object.keys(body), args, extraHints);
    if (Object.hasOwn(body, 'input')) body.input = await messagesFor(args, 'responses', ctx.config);
    const response = await ctx.request('/v1/responses', { method: 'POST', body: mergeExtra(body, args), allowText: args.raw });
    if (args.raw) return rawResult(response, ctx.config);
    const data = response.body;
    expectResponse(data);
    const output = data?.output ?? [];
    const split = splitThinking(output.flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join(''), args.split_thinking !== false);
    const reasoning = output.filter(item => item.type === 'reasoning').flatMap(reasoningParts).map(part => part.text ?? '').join('\n');
    const function_calls = output.filter(item => item.type === 'function_call').map(item => ({ ...redact({ id: item.id ?? null, call_id: item.call_id ?? null, name: item.name }, ctx.config), arguments: redactPicoData(parseArguments(item.arguments), ctx.config), status: redact(item.status ?? null, ctx.config) }));
    const usage = data?.usage ?? {};
    return result({ ...redact({ answer: split.answer, refusal: responseRefusal(output), reasoning: [split.reasoning, reasoning].filter(Boolean).join('\n'), response_id: data?.id ?? null, response_model: data?.model ?? null, status: data?.status ?? null, created_at: data?.created_at ?? null, completed_at: data?.completed_at ?? null, usage: {
      input_tokens: usage.input_tokens ?? null, output_tokens: usage.output_tokens ?? null, reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? null, cached_tokens: usage.input_tokens_details?.cached_tokens ?? null,
      total_tokens: usage.total_tokens ?? null, prompt_time_ms: usage.prompt_time_ms ?? null, generation_time_ms: usage.generation_time_ms ?? null
    } }, ctx.config), error: redactPicoData(data?.error ?? null, ctx.config), incomplete_details: redactPicoData(data?.incomplete_details ?? null, ctx.config), function_calls, custom_tool_calls: customToolCalls(output, ctx.config) });
  }
};
