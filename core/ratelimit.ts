/**
 * 每源节流 + 重试 + 统一 JSON 请求。
 * 移植自 Idea-Studio core/retrieval/providers.ts 的 jsonRequest 模式，精简为：
 * - RateLimiter 保证同一源的请求间隔（并发安全，promise 链串行化）
 * - requestJson 处理超时 / 429+Retry-After / 5xx / 网络错误重试 / 错误分类
 */

export type ProviderErrorCode = 'rate_limited' | 'auth_failed' | 'provider_unavailable' | 'bad_request';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    /** true = 值得稍后重试（限流、暂时不可用、网络抖动） */
    readonly temporary: boolean,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface RateLimiterOptions {
  /** 同一源两次请求之间的最小间隔（毫秒） */
  intervalMs: number;
  /** 测试可注入；默认真实 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** 测试可注入；默认 Date.now */
  now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 最小间隔节流器：无论多少并发 acquire()，放行时刻彼此至少相隔 intervalMs。
 * 实现为一条 promise 链，每个 acquire 排在链尾。
 */
export class RateLimiter {
  private tail: Promise<number> = Promise.resolve(0);
  private readonly intervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.intervalMs = Math.max(0, options.intervalMs);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  /** 等到轮到自己且距上次放行已满 intervalMs，然后放行。 */
  acquire(): Promise<void> {
    const turn = this.tail.then(async (lastRelease) => {
      const wait = this.intervalMs - (this.now() - lastRelease);
      if (wait > 0) await this.sleep(wait);
      return this.now();
    });
    // 链上携带的是"本次放行时刻"；失败不应毒化后续调用
    this.tail = turn.catch(() => this.now());
    return turn.then(() => undefined);
  }
}

export interface RequestJsonOptions {
  /** 数据源名，仅用于错误信息 */
  provider: string;
  limiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** 总尝试次数（含首次），默认 2 */
  maxAttempts?: number;
  /** 单次请求超时（毫秒），默认 20000 */
  timeoutMs?: number;
  /** 响应解析方式，默认 'json'；'text' 用于 XML/HTML 源 */
  responseAs?: 'json' | 'text';
}

function userAgent(): string {
  return 'literature-search-agent/0.1 (https://github.com/literature-search-agent)';
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      },
      { once: true },
    );
  });
}

function retryAfterMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get('retry-after') || 0);
  const fromHeader = Number.isFinite(header) && header > 0 ? header * 1000 : 0;
  const backoff = 800 * 2 ** attempt;
  // Retry-After clamp 到 1–10s；无头时用指数退避
  return fromHeader > 0 ? Math.min(10_000, Math.max(1_000, fromHeader)) : backoff;
}

/**
 * 通用 GET：先过节流器，再带超时发请求。
 * 404 → undefined；429/5xx/网络错误 → 有限重试；其余非 2xx → ProviderError。
 * responseAs: 'json'（默认）或 'text'（XML/HTML 源）。
 */
export async function requestJson(url: URL, options: RequestJsonOptions): Promise<unknown> {
  const {
    provider,
    limiter,
    fetchImpl = fetch,
    signal,
    headers = {},
    maxAttempts = 2,
    timeoutMs = 20_000,
    responseAs = 'json',
  } = options;
  const requestHeaders: Record<string, string> = {
    Accept: responseAs === 'text' ? 'application/atom+xml, text/xml;q=0.9, text/html;q=0.8' : 'application/json',
    'User-Agent': userAgent(),
    ...headers,
  };

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await limiter?.acquire();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: requestHeaders,
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (attempt < maxAttempts - 1) {
        await abortableSleep(800 * 2 ** attempt, signal);
        continue;
      }
      throw new ProviderError(
        `${provider} 连接失败：${error instanceof Error ? error.message : String(error)}`,
        'provider_unavailable',
        true,
      );
    }

    if (response.ok) return responseAs === 'text' ? response.text() : response.json();
    if (response.status === 404) return undefined;
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(`${provider} 认证失败或请求被拒绝（HTTP ${response.status}）。`, 'auth_failed', false, response.status);
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxAttempts - 1) {
        await abortableSleep(retryAfterMs(response, attempt), signal);
        continue;
      }
      throw new ProviderError(
        `${provider} 暂时不可用（HTTP ${response.status}）。`,
        response.status === 429 ? 'rate_limited' : 'provider_unavailable',
        true,
        response.status,
      );
    }
    throw new ProviderError(`${provider} 请求失败（HTTP ${response.status}）。`, 'bad_request', false, response.status);
  }
  // 不可达：循环要么 return 要么 throw
  throw new ProviderError(`${provider} 请求失败。`, 'provider_unavailable', true);
}

/** requestJson 的文本响应版本（arXiv Atom XML / OA HTML 页面）。404 → 空串。 */
export async function requestText(url: URL, options: Omit<RequestJsonOptions, 'responseAs'>): Promise<string> {
  const value = await requestJson(url, { ...options, responseAs: 'text' });
  return typeof value === 'string' ? value : '';
}
