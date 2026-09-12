/**
 * OpenAlex provider：search / lookup by DOI / cited-by。
 * 映射逻辑移植自 Idea-Studio core/retrieval/providers.ts（openAlexCandidate、
 * invertOpenAlexAbstract）与 core/literature-mining/graph.ts（cites: 过滤）。
 *
 * 认证三档（provider 内解析，不读 process.env，由接口层注入）：
 *   1. apiKey  → ?api_key=...（账户额度，10 rps）
 *   2. mailto  → ?mailto=...（polite pool，10 rps）
 *   3. 都没有  → 匿名普通池（保守 2 rps）
 */

import { record, text } from '../json.js';
import { clampLimit, runSearchPipeline } from '../pipeline.js';
import { dedupeWorks, normalizeDoi } from '../dedupe.js';
import { ProviderError, RateLimiter, requestJson } from '../ratelimit.js';
import type { SearchOptions, SearchResult, WorkItem } from '../types.js';

const API_BASE = 'https://api.openalex.org';

export interface OpenAlexAuth {
  apiKey?: string;
  mailto?: string;
}

export interface OpenAlexOptions extends SearchOptions, OpenAlexAuth {
  fetchImpl?: typeof fetch;
}

type AuthTier = 'api_key' | 'mailto' | 'anonymous';

/** OpenAlex 摘要的倒排索引还原为文本。 */
export function invertOpenAlexAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.filter(Boolean).join(' ').trim();
}

/** OpenAlex work JSON → WorkItem；无标题返回 undefined。 */
export function mapOpenAlexWork(value: unknown): WorkItem | undefined {
  const work = record(value);
  const title = text(work.title) || text(work.display_name);
  if (!title) return undefined;

  const authorships = Array.isArray(work.authorships) ? work.authorships : [];
  const authors = authorships.flatMap((entry) => {
    const name = text(record(record(entry).author).display_name);
    return name ? [name] : [];
  });

  const primary = record(work.primary_location);
  const source = record(primary.source);
  const bestOa = record(work.best_oa_location);
  const ids = record(work.ids);

  const doi = text(work.doi) ? normalizeDoi(text(work.doi)) : '';
  const abstract = invertOpenAlexAbstract(work.abstract_inverted_index as Record<string, number[]> | null | undefined).slice(0, 100_000);

  const externalIds: Record<string, string> = {};
  const openalexId = text(work.id);
  if (openalexId) externalIds.openalex = openalexId;
  if (doi) externalIds.doi = doi;
  for (const key of ['mag', 'pmid'] as const) {
    const id = text(ids[key]);
    if (id) externalIds[key] = id;
  }

  return {
    title,
    authors: [...new Set(authors)].slice(0, 30),
    year: typeof work.publication_year === 'number' ? work.publication_year : null,
    venue: text(source.display_name),
    doi,
    url: text(primary.landing_page_url) || openalexId,
    citationCount: typeof work.cited_by_count === 'number' && work.cited_by_count >= 0 ? work.cited_by_count : null,
    abstract,
    abstractStatus: abstract ? 'complete' : 'pending',
    oaPdfUrl: text(bestOa.pdf_url) || text(primary.pdf_url),
    source: 'openalex',
    externalIds,
  };
}

/** 三档认证：key 优先，mailto 次之，匿名兜底。返回档位 + 应用到 URL 的参数。 */
function resolveAuth(auth: OpenAlexAuth): { tier: AuthTier; apply: (url: URL) => void } {
  const apiKey = auth.apiKey?.trim();
  if (apiKey) return { tier: 'api_key', apply: (url) => url.searchParams.set('api_key', apiKey) };
  const mailto = auth.mailto?.trim();
  if (mailto) return { tier: 'mailto', apply: (url) => url.searchParams.set('mailto', mailto) };
  return { tier: 'anonymous', apply: () => undefined };
}

/** 每档一个共享节流器（模块级缓存，CLI 单进程内复用）。 */
const limiters = new Map<AuthTier, RateLimiter>();
function limiterFor(tier: AuthTier): RateLimiter {
  const cached = limiters.get(tier);
  if (cached) return cached;
  const limiter = new RateLimiter({ intervalMs: tier === 'anonymous' ? 500 : 100 });
  limiters.set(tier, limiter);
  return limiter;
}

async function openAlexGet(url: URL, options: OpenAlexOptions): Promise<unknown> {
  const auth = resolveAuth(options);
  auth.apply(url);
  return requestJson(url, {
    provider: 'openalex',
    limiter: limiterFor(auth.tier),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

function resultsOf(value: unknown): unknown[] {
  const results = record(value).results;
  return Array.isArray(results) ? results : [];
}

function yearFilter(options: SearchOptions): string {
  if (options.yearFrom && options.yearTo) return `publication_year:${options.yearFrom}-${options.yearTo}`;
  if (options.yearFrom) return `publication_year:>${options.yearFrom - 1}`;
  if (options.yearTo) return `publication_year:<${options.yearTo + 1}`;
  return '';
}

/** 关键词检索。provider 失败时返回空结果 + diagnostics，不向上抛。 */
export async function searchOpenAlex(query: string, options: OpenAlexOptions = {}): Promise<SearchResult> {
  const q = query.replace(/\s+/g, ' ').trim();
  if (!q) throw new ProviderError('检索词不能为空。', 'bad_request', false, 400);
  const limit = clampLimit(options.limit, 10, 200);

  const url = new URL(`${API_BASE}/works`);
  url.searchParams.set('search', q);
  url.searchParams.set('per_page', String(limit));
  const years = yearFilter(options);
  if (years) url.searchParams.set('filter', years);

  return runSearchPipeline({
    source: 'openalex',
    limit,
    rawsOf: resultsOf,
    mapItem: mapOpenAlexWork,
    fetch: () => openAlexGet(url, options),
  });
}

/** 按 DOI 查单篇。找不到（404）返回 undefined；其他错误向上抛。 */
export async function lookupOpenAlexByDoi(doi: string, options: OpenAlexOptions = {}): Promise<WorkItem | undefined> {
  const normalized = normalizeDoi(doi);
  if (!normalized) throw new ProviderError('DOI 不能为空。', 'bad_request', false, 400);
  const url = new URL(`${API_BASE}/works/doi:${encodeURIComponent(normalized)}`);
  const value = await openAlexGet(url, options);
  return value === undefined ? undefined : mapOpenAlexWork(value);
}

/**
 * 被引列表：OpenAlex `filter=cites:<openalex-id>`（移植 graph.ts）。
 * 传 DOI 时先 lookup 解析出 OpenAlex id。单页返回，不做 cursor 翻页。
 */
export async function citedByOpenAlex(doiOrOpenAlexId: string, options: OpenAlexOptions = {}): Promise<SearchResult> {
  let openAlexId = doiOrOpenAlexId.trim();
  if (!/^https?:\/\/openalex\.org\/W\d+$/i.test(openAlexId) && !/^W\d+$/i.test(openAlexId)) {
    const work = await lookupOpenAlexByDoi(openAlexId, options);
    if (!work?.externalIds.openalex) {
      return {
        items: [],
        diagnostics: { openalex: { ok: false, count: 0, error: `无法解析 "${doiOrOpenAlexId}" 为 OpenAlex work。` } },
      };
    }
    openAlexId = work.externalIds.openalex;
  }

  const limit = clampLimit(options.limit, 25, 200);
  const url = new URL(`${API_BASE}/works`);
  url.searchParams.set('filter', `cites:${openAlexId}`);
  url.searchParams.set('per_page', String(limit));

  return runSearchPipeline({
    source: 'openalex',
    limit,
    rawsOf: resultsOf,
    mapItem: mapOpenAlexWork,
    fetch: () => openAlexGet(url, options),
  });
}
