export interface OpenUsageClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:6736';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export async function fetchOpenUsageLimits(options: OpenUsageClientOptions = {}): Promise<unknown> {
  const baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
  if (!LOOPBACK_HOSTS.has(baseUrl.hostname)) {
    throw new Error('OpenUsage base URL must use a loopback host');
  }
  if (baseUrl.protocol !== 'http:') {
    throw new Error('OpenUsage loopback URL must use http');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await fetch(new URL('/v1/limits', baseUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenUsage request failed with HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
