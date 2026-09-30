/** Resolve settings once at the process boundary. Other transports may pass their own environment. */
export function baseUrlConfigurationError(baseUrl) {
  const value = String(baseUrl ?? '').trim();
  if (!value || value.startsWith('${')) return { kind: 'invalid_configuration', message: 'PICO_BASE_URL is not set; configure base_url.' };
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return { kind: 'invalid_configuration', message: 'base_url must be an http or https URL.' };
    if (url.username || url.password) return { kind: 'invalid_configuration', message: 'base_url must not contain credentials; use api_key instead.' };
  } catch { return { kind: 'invalid_configuration', message: 'base_url must be an http or https URL.' }; }
  if (String(baseUrl).includes('?') || String(baseUrl).includes('#')) return { kind: 'invalid_configuration', message: 'base_url must not contain a query or fragment.' };
  return null;
}

export function readConfig(env = process.env) {
  const setting = (key, fallback) => {
    const value = String(env[key] ?? '').trim();
    return !value || /^\$\{[^}]+\}$/.test(value) ? fallback : value;
  };
  const timeout = Number(setting('PICO_TIMEOUT_MS', '300000'));
  const concurrency = Number(setting('PICO_MAX_CONCURRENT_REQUESTS', '1'));
  const baseUrl = String(env.PICO_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const configurationError = baseUrlConfigurationError(baseUrl) ??
    (!Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647 ? { kind: 'invalid_configuration', message: 'PICO_TIMEOUT_MS must be an integer from 1 through 2147483647.' } :
      !Number.isSafeInteger(concurrency) || concurrency < 1 ? { kind: 'invalid_configuration', message: 'PICO_MAX_CONCURRENT_REQUESTS must be a safe integer of at least 1.' } : null);
  return {
    baseUrl,
    configurationError,
    apiKey: setting('PICO_API_KEY', ''),
    timeoutMs: timeout,
    maxConcurrentRequests: concurrency
  };
}
