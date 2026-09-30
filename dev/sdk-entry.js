import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { info } from '../server/core/server-info.js';
import { publicTools } from '../server/core/registry.js';
import { startWithSdk } from '../server/adapters/sdk.js';
startWithSdk({ info, tools: publicTools(), sdk: { McpServer, fromJsonSchema, serveStdio } });
