/**
 * Semantic Scholar Graph API provider：search + DOI lookup。
 * 移植自 Idea-Studio core/retrieval/providers.ts 的 semanticScholarAbstract，扩展为完整检索。
 *
 * 节流双档（模块级共享 RateLimiter）：
 *   - 有 API key（x-api-key 头）→ 独享 1 rps
 *   - 无 key → 匿名共享池，保守 3s 间隔（官方约 100 次/5 分钟，且常 429）
 */

import { record, text } from '../json.js';
import { clampLimit, runSearchPipeline } from '../pipeline.js';
import { dedupeWorks, normalizeDoi } from '../dedupe.js';
import { ProviderError, RateLimiter, requestJson } from '../ratelimit.js';
import type { SearchOptions, SearchResult, WorkItem } from '../types.js';

const API_BASE = 'https://api.semanticscholar.org/graph/v1';

const FIELDS = 'title,authors.name,year,venue,externalIds,abstract,citationCount,openAccessPdf,url';

export interface S2Options extends SearchOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** S2 paper JSON → WorkItem；无标题返回 undefined。 */
export function mapS2Paper(value: unknown): WorkItem | undefined {
  const paper = record(value);
  const title = text(paper.title);
  if (!title) return undefined;

  const authors = (Array.isArray(paper.authors) ? paper.authors : [])
    .flatMap((entry) => {
      const name = text(record(entry).name);
      return name ? [name] : [];
    });

  const ids = record(paper.externalIds);
  const doi = text(ids.DOI) ? normalizeDoi(text(ids.DOI)) : '';
  const oaPdf = record(paper.openAccessPdf);

  const externalIds: Record<string, string> = {};
  const paperId = text(paper.paperId);
  if (paperId) externalIds.s2 = paperId;
  if (doi) externalIds.doi = doi;
  const arxiv = text(ids.ArXiv);
  if (arxiv) externalIds.arxiv = arxiv;

  const abstract = text(paper.abstract).replace(/\s+/g, ' ').slice(0, 100_000);

  return {
    title,
    authors: [...new Set(authors)].slice(0, 30),
    year: typeof paper.year === 'number' ? paper.year : null,
    venue: text(paper.venue),
    doi,
    url: text(paper.url),
    citationCount: typeof paper.citationCount === 'number' && paper.citationCount >= 0 ? paper.citationCount : null,
    abstract,
    abstractStatus: abstract ? 'complete' : 'pending',
    oaPdfUrl: text(oaPdf.url),
    source: 'semanticscholar',
    externalIds,
  };
}

const limiters = new Map<string, RateLimiter>();
function limiterFor(hasKey: boolean): RateLimiter {
  const tier = hasKey ? 'key' : 'anonymous';
  const cached = limiters.get(tier);
  if (cached) return cached;
  const limiter = new RateLimiter({ intervalMs: hasKey ? 1000 : 3000 });
  limiters.set(tier, limiter);
  return limiter;
}

async function s2Get(url: URL, options: S2Options): Promise<unknown> {
  const apiKey = options.apiKey?.trim();
  return requestJson(url, {
    provider: 'semantic_scholar',
    limiter: limiterFor(Boolean(apiKey)),
    headers: apiKey ? { 'x-api-key': apiKey } : {},
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

function s2Data(value: unknown): unknown[] {
  const data = record(value).data;
  return Array.isArray(data) ? data : [];
}

/** 关键词检索（S2 /paper/search）。失败返回空结果 + diagnostics，不向上抛。 */
export async function searchSemanticScholar(query: string, options: S2Options = {}): Promise<SearchResult> {
  const q = query.replace(/\s+/g, ' ').trim();
  if (!q) throw new ProviderError('检索词不能为空。', 'bad_request', false, 400);
  const limit = clampLimit(options.limit, 10, 100);

  const url = new URL(`${API_BASE}/paper/search`);
  url.searchParams.set('query', q);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', FIELDS);
  if (options.yearFrom || options.yearTo) {
    url.searchParams.set('year', `${options.yearFrom ?? ''}-${options.yearTo ?? ''}`);
  }

  return runSearchPipeline({
    source: 'semanticscholar',
    limit,
    rawsOf: s2Data,
    mapItem: mapS2Paper,
    fetch: () => s2Get(url, options),
  });
}

/** 按 DOI 查单篇（含摘要）。404 → undefined；其他错误向上抛。 */
export async function lookupS2ByDoi(doi: string, options: S2Options = {}): Promise<WorkItem | undefined> {
  const normalized = normalizeDoi(doi);
  if (!normalized) throw new ProviderError('DOI 不能为空。', 'bad_request', false, 400);
  const url = new URL(`${API_BASE}/paper/DOI:${encodeURIComponent(normalized)}`);
  url.searchParams.set('fields', FIELDS);
  const value = await s2Get(url, options);
  return value === undefined ? undefined : mapS2Paper(value);
}
