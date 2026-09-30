import { info } from './core/server-info.js';
import { publicTools } from './core/registry.js';
import { startStdioJsonRpc } from './adapters/stdio-jsonrpc.js';
startStdioJsonRpc({ info, tools: publicTools() });
