import { callTool, createContext, publicTools } from '../core/registry.js';
import { readConfig } from '../core/config.js';

/** SDK modules are injected so the distributed server has no runtime dependencies. */
export function startWithSdk({ info, tools = publicTools(), sdk, config = readConfig() }) {
  const { McpServer, fromJsonSchema, serveStdio } = sdk;
  const ctx = createContext(config);
  return serveStdio(() => {
    const server = new McpServer({ name: info.name, version: info.version }, {
      capabilities: { tools: { listChanged: false } }, instructions: info.instructions,
      cacheHints: { tools: { ttlMs: 300000, cacheScope: 'public' } }
    });
    for (const tool of tools) {
      server.registerTool(tool.name, {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema),
        annotations: tool.annotations
      }, async (args, handlerContext) => callTool(tool.name, args, ctx, { signal: handlerContext.signal }));
    }
    return server;
  });
}
