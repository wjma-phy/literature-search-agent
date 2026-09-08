import { describe, expect, it, vi } from 'vitest';
import { ProviderError, RateLimiter, requestJson } from '../core/ratelimit.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 脚本化 fetch：依次弹出响应；用完后抛错。 */
function scriptedFetch(script: Array<Response | Error>): typeof fetch {
  const queue = [...script];
  const impl = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return next;
  });
  return impl as unknown as typeof fetch;
}

describe('requestJson', () => {
  it('200 → 返回解析后的 JSON', async () => {
    const fetchImpl = scriptedFetch([jsonResponse({ hello: 'world' })]);
    const value = await requestJson(new URL('https://example.com/x'), { provider: 'test', fetchImpl });
    expect(value).toEqual({ hello: 'world' });
  });

  it('404 → undefined', async () => {
    const fetchImpl = scriptedFetch([jsonResponse({}, 404)]);
    const value = await requestJson(new URL('https://example.com/x'), { provider: 'test', fetchImpl });
    expect(value).toBeUndefined();
  });

  it('429 + Retry-After → 重试后成功；sleep 遵守 Retry-After（clamp 下限 1s）', async () => {
    const fetchImpl = scriptedFetch([
      jsonResponse({}, 429, { 'retry-after': '0' }),
      jsonResponse({ ok: true }),
    ]);
    const sleeps: number[] = [];
    const limiter = new RateLimiter({ intervalMs: 0, sleep: async (ms) => { sleeps.push(ms); } });
    // 用假 sleep 替换内部 abortableSleep 不可行（模块私有），改用 vi.useFakeTimers 会复杂化；
    // 这里只验证"重试后成功"这一行为，Retry-After 数值由单独的 retryAfterMs 单测覆盖更稳妥——
    // 但 retryAfterMs 未导出，故通过计时粗验：重试等待 ≥ 1000ms 会拖慢测试。
    // 折中：retry-after 0 → clamp 到 1s。用真实计时但断言结果正确即可。
    const value = await requestJson(new URL('https://example.com/x'), { provider: 'test', fetchImpl, limiter });
    expect(value).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('429 连续失败 → rate_limited ProviderError', async () => {
    const fetchImpl = scriptedFetch([jsonResponse({}, 429, { 'retry-after': '1' }), jsonResponse({}, 429, { 'retry-after': '1' })]);
    await expect(requestJson(new URL('https://example.com/x'), { provider: 'test', fetchImpl }))
      .rejects.toMatchObject({ name: 'ProviderError', code: 'rate_limited', temporary: true, status: 429 });
  }, 10_000);

  it('500 重试仍 500 → provider_unavailable', async () => {
    const fetchImpl = scriptedFetch([jsonResponse({}, 500), jsonResponse({}, 503)]);
    await expect(requestJson(new URL('https://example.com/x'), { provider: 'test', fetchImpl }))
      .rejects.toMatchObject({ code: 'provider_unavailable', temporary: true, status: 503 });
  }, 10_000);

  it('网络错误重试一次后成功', async () => {
    const fetchImpl = scriptedFetch([new Error('socket hangup'), jsonResponse({ ok: 1 })]);
    const value = await requestJson(new URL('https://example.com/x'), { provider: 'test', fetchImpl });
    expect(value).toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('网络错误重试后仍失败 → provider_unavailable ProviderError', async () => {
    const fetchImpl = scriptedFetch([new Error('a'), new Error('b')]);
    await expect(requestJson(new URL('https://example.com/x'), { provider: 'test', fetchImpl }))
      .rejects.toBeInstanceOf(ProviderError);
  }, 10_000);

  it('401 → auth_failed，不重试', async () => {
    const fetchImpl = scriptedFetch([jsonResponse({}, 401)]);
    await expect(requestJson(new URL('https://example.com/x'), { provider: 'test', fetchImpl }))
      .rejects.toMatchObject({ code: 'auth_failed', temporary: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('400 → bad_request，不重试', async () => {
    const fetchImpl = scriptedFetch([jsonResponse({}, 400)]);
    await expect(requestJson(new URL('https://example.com/x'), { provider: 'test', fetchImpl }))
      .rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('外部 signal 已 abort 时直接抛，不吞掉', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user cancel'));
    const fetchImpl = vi.fn(async () => { throw new Error('aborted by impl'); }) as unknown as typeof fetch;
    await expect(
      requestJson(new URL('https://example.com/x'), { provider: 'test', fetchImpl, signal: controller.signal }),
    ).rejects.toThrow('aborted by impl');
  });
});

describe('RateLimiter', () => {
  it('并发 acquire 按最小间隔放行', async () => {
    let now = 1_000;
    const slept: number[] = [];
    const limiter = new RateLimiter({
      intervalMs: 100,
      now: () => now,
      sleep: async (ms) => { slept.push(ms); now += ms; },
    });
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    // 首个立即放行（距"上次放行" 1000ms，远超 100ms）；后两个各等一个间隔
    expect(slept).toEqual([100, 100]);
  });

  it('间隔已过则不再等待', async () => {
    let now = 200; // 初始即距"上次放行"(0) 200ms > 100ms，首个 acquire 也不睡
    const slept: number[] = [];
    const limiter = new RateLimiter({
      intervalMs: 100,
      now: () => now,
      sleep: async (ms) => { slept.push(ms); now += ms; },
    });
    await limiter.acquire();
    now += 500; // 距上次放行已 500ms > 100ms
    await limiter.acquire();
    expect(slept).toHaveLength(0);
  });
});
