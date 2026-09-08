/**
 * Crossref provider：DOI lookup + bibliographic / title+author 检索。
 * 映射移植自 Idea-Studio core/retrieval/providers.ts 的 crossrefCandidate /
 * cleanCrossrefAbstract。
 *
 * 节流：有 mailto → polite pool 100ms；无 → 匿名 1000ms 保守档。
 */

import { dedupeWorks, normalizeDoi } from '../dedupe.js';
import { ProviderError, RateLimiter, requestJson } from '../ratelimit.js';
import type { SearchOptions, SearchResult, WorkItem } from '../types.js';

const API_BASE = 'https://api.crossref.org';

export interface CrossrefOptions extends SearchOptions {
  mailto?: string;
  fetchImpl?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Crossref abstract 字段常带 JATS/HTML 标签与实体，清洗为纯文本。 */
export function cleanCrossrefAbstract(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Crossref work message → WorkItem；无标题返回 undefined。 */
export function mapCrossrefWork(value: unknown): WorkItem | undefined {
  const message = record(value);
  const titleField = message.title;
  const title = Array.isArray(titleField) ? text(titleField[0]) : text(titleField);
  if (!title) return undefined;

  const authors = (Array.isArray(message.author) ? message.author : []).flatMap((entry) => {
    const author = record(entry);
    const name = [author.given, author.family]
      .filter((part): part is string => typeof part === 'string')
      .join(' ')
      .trim();
    return name ? [name] : [];
  });

  const published = record(message.published);
  const dateParts = Array.isArray(published['date-parts']) ? (published['date-parts'] as unknown[][]) : [];
  const firstDate = dateParts[0];
  const year = typeof firstDate?.[0] === 'number' ? firstDate[0] : null;

  const containerTitle = message['container-title'];
  const venue = Array.isArray(containerTitle) ? text(containerTitle[0]) : '';

  const doi = text(message.DOI) ? normalizeDoi(text(message.DOI)) : '';
  const abstract = cleanCrossrefAbstract(text(message.abstract) || undefined).slice(0, 100_000);

  // link 里的 PDF 直链可作 OA 候选
  const oaPdfUrl = (Array.isArray(message.link) ? message.link : []).flatMap((entry) => {
    const link = record(entry);
    if (!/application\/pdf/i.test(text(link['content-type']))) return [];
    const url = text(link.URL);
    return url ? [url.replace(/^http:/i, 'https:')] : [];
  })[0] ?? '';

  const externalIds: Record<string, string> = {};
  if (doi) externalIds.doi = doi;

  return {
    title,
    authors: [...new Set(authors)].slice(0, 30),
    year,
    venue,
    doi,
    url: text(message.URL),
    citationCount: typeof message['is-referenced-by-count'] === 'number' ? message['is-referenced-by-count'] : null,
    abstract,
    abstractStatus: abstract ? 'complete' : 'pending',
    oaPdfUrl,
    source: 'crossref',
    externalIds,
  };
}

const limiters = new Map<string, RateLimiter>();
function limiterFor(hasMailto: boolean): RateLimiter {
  const tier = hasMailto ? 'mailto' : 'anonymous';
  const cached = limiters.get(tier);
  if (cached) return cached;
  const limiter = new RateLimiter({ intervalMs: hasMailto ? 100 : 1000 });
  limiters.set(tier, limiter);
  return limiter;
}

async function crossrefGet(url: URL, options: CrossrefOptions): Promise<unknown> {
  const mailto = options.mailto?.trim();
  if (mailto) url.searchParams.set('mailto', mailto);
  return requestJson(url, {
    provider: 'crossref',
    limiter: limiterFor(Boolean(mailto)),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}

function diagnostics(error: unknown): SearchResult['diagnostics'] {
  return {
    crossref: {
      ok: false,
      count: 0,
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

function messageItems(value: unknown): unknown[] {
  const items = record(record(value).message).items;
  return Array.isArray(items) ? items : [];
}

/**
 * 书目检索：query.bibliographic 为主，可选 author 收窄（query.author）。
 * 年份范围映射为 from-pub-date / until-pub-date 过滤。失败返回空结果 + diagnostics。
 */
export async function searchCrossref(query: string, options: CrossrefOptions & { author?: string } = {}): Promise<SearchResult> {
  const q = query.replace(/\s+/g, ' ').trim();
  if (!q) throw new ProviderError('检索词不能为空。', 'bad_request', false, 400);
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);

  const url = new URL(`${API_BASE}/works`);
  url.searchParams.set('query.bibliographic', q);
  const author = options.author?.trim();
  if (author) url.searchParams.set('query.author', author);
  url.searchParams.set('rows', String(limit));
  const filters: string[] = [];
  if (options.yearFrom) filters.push(`from-pub-date:${options.yearFrom}-01-01`);
  if (options.yearTo) filters.push(`until-pub-date:${options.yearTo}-12-31`);
  if (filters.length) url.searchParams.set('filter', filters.join(','));

  try {
    const value = await crossrefGet(url, options);
    const items = dedupeWorks(messageItems(value).flatMap((raw) => {
      const item = mapCrossrefWork(raw);
      return item ? [item] : [];
    })).slice(0, limit);
    return { items, diagnostics: { crossref: { ok: true, count: items.length } } };
  } catch (error) {
    return { items: [], diagnostics: diagnostics(error) };
  }
}

/** 按 DOI 查单篇。404 → undefined；其他错误向上抛。 */
export async function lookupCrossrefByDoi(doi: string, options: CrossrefOptions = {}): Promise<WorkItem | undefined> {
  const normalized = normalizeDoi(doi);
  if (!normalized) throw new ProviderError('DOI 不能为空。', 'bad_request', false, 400);
  const url = new URL(`${API_BASE}/works/${encodeURIComponent(normalized)}`);
  const value = await crossrefGet(url, options);
  return value === undefined ? undefined : mapCrossrefWork(record(value).message);
}
