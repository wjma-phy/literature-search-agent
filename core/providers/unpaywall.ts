/**
 * Unpaywall provider：DOI → OA 位置（PDF 直链 / landing page）。
 * 移植自 Idea-Studio core/retrieval/providers.ts 的 unpaywallAbstract 的位置枚举逻辑。
 * 需要 email（Unpaywall 强制要求 ?email=）。节流 100ms（上限 10 万次/天）。
 */

import { normalizeDoi } from '../dedupe.js';
import { ProviderError, RateLimiter, requestJson } from '../ratelimit.js';

export interface UnpaywallLocation {
  /** OA PDF 直链（可能为空） */
  pdfUrl: string;
  /** OA 落地页 */
  landingUrl: string;
  hostType: string;
  license: string;
  /** 是否 best_oa_location */
  isBest: boolean;
}

export interface UnpaywallRecord {
  doi: string;
  isOa: boolean;
  /** 最佳 OA PDF 直链（无则空串） */
  bestPdfUrl: string;
  /** 最佳 OA 落地页（无则空串） */
  bestLandingUrl: string;
  locations: UnpaywallLocation[];
}

export interface UnpaywallOptions {
  /** Unpaywall 必填的联系邮箱 */
  email?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mapLocation(value: unknown, isBest: boolean): UnpaywallLocation {
  const location = record(value);
  return {
    pdfUrl: text(location.url_for_pdf),
    landingUrl: text(location.url_for_landing_page) || text(location.url),
    hostType: text(location.host_type),
    license: text(location.license),
    isBest,
  };
}

const limiter = new RateLimiter({ intervalMs: 100 });

/** 按 DOI 查 OA 状态。404（Unpaywall 未收录）→ undefined；缺 email → bad_request。 */
export async function lookupUnpaywall(doi: string, options: UnpaywallOptions = {}): Promise<UnpaywallRecord | undefined> {
  const normalized = normalizeDoi(doi);
  if (!normalized) throw new ProviderError('DOI 不能为空。', 'bad_request', false, 400);
  const email = options.email?.trim();
  if (!email) throw new ProviderError('Unpaywall 需要配置联系邮箱（LIT_SEARCH_MAILTO）。', 'bad_request', false, 400);

  const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(normalized)}`);
  url.searchParams.set('email', email);
  const value = await requestJson(url, {
    provider: 'unpaywall',
    limiter,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (value === undefined) return undefined;

  const raw = record(value);
  const best = raw.best_oa_location;
  const locations: UnpaywallLocation[] = [];
  if (best && typeof best === 'object') locations.push(mapLocation(best, true));
  for (const entry of Array.isArray(raw.oa_locations) ? raw.oa_locations : []) {
    const mapped = mapLocation(entry, false);
    if (!locations.some((l) => l.pdfUrl === mapped.pdfUrl && l.landingUrl === mapped.landingUrl)) {
      locations.push(mapped);
    }
  }

  return {
    doi: normalized,
    isOa: raw.is_oa === true,
    bestPdfUrl: locations[0]?.pdfUrl ?? '',
    bestLandingUrl: locations[0]?.landingUrl ?? '',
    locations,
  };
}
