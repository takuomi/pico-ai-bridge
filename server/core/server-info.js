import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const info = {
  name: 'pico-ai-bridge',
  version: pkg.version,
  instructions: 'Use pico_server_info to check connectivity, pico_list_models to choose a model, pico_responses for usage, JSON schema and function calls, pico_chat_completions for broad compatibility, pico_ollama_chat for context and keep_alive, pico_compare_models for sequential comparisons.'
};
