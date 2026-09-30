import { nonFiniteNumbers, validate } from './validate.js';
import { baseUrlConfigurationError } from './config.js';
import { errorResult } from './util.js';
import { createPicoClient } from '../pico-client.js';
import { tool as serverInfo } from '../tools/server-info.js';
import { tool as listModels } from '../tools/list-models.js';
import { tool as responses } from '../tools/responses.js';
import { tool as chatCompletions } from '../tools/chat-completions.js';
import { tool as ollamaChat } from '../tools/ollama-chat.js';
import { tool as compareModels } from '../tools/compare-models.js';

/** Plain tool objects; transports only depend on this API. */
export const tools = [serverInfo, listModels, responses, chatCompletions, ollamaChat, compareModels];
export const publicTools = () => tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
export function createContext(config) { return { config, request: createPicoClient(config) }; }
export async function callTool(name, args, ctx, { signal } = {}) {
  const configurationError = ctx.config.configurationError ?? baseUrlConfigurationError(ctx.config.baseUrl);
  if (configurationError) return errorResult(configurationError, ctx.config);
  const tool = tools.find(item => item.name === name);
  if (!tool) return errorResult({ kind: 'unknown_tool', message: `Unknown tool: ${name}` }, ctx.config);
  const numbers = nonFiniteNumbers(args ?? {});
  const issues = numbers.length ? numbers : validate(tool.inputSchema, args ?? {});
  if (issues.length) return errorResult({ kind: 'invalid_arguments', message: issues.join('; ') }, ctx.config);
  const callContext = { ...ctx, signal, request: (path, options) => ctx.request(path, { ...options, signal }) };
  try { return await tool.handler(args ?? {}, callContext); }
  catch (error) { return errorResult(error, ctx.config); }
}
