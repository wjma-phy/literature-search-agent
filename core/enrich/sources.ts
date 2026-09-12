/**
 * 摘要专用补充源：Europe PMC 与 arXiv（只用于富集链按 DOI 查摘要）。
 * 移植自 Idea-Studio core/retrieval/providers.ts 的 europePmcAbstract / arxivAbstract。
 */

import { record } from '../json.js';
import { cleanMarkup } from '../clean.js';
import { RateLimiter, requestJson, requestText } from '../ratelimit.js';

export interface SourceOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const europePmcLimiter = new RateLimiter({ intervalMs: 200 });
// arXiv 官方要求 ≤1 次/3 秒
const arxivLimiter = new RateLimiter({ intervalMs: 3000 });

/** Europe PMC：按 DOI 搜 resultType=core 拿 abstractText。 */
export async function europePmcAbstract(doi: string, options: SourceOptions = {}): Promise<string> {
  const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
  url.searchParams.set('query', `DOI:${doi}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('resultType', 'core');
  url.searchParams.set('pageSize', '1');
  const value = await requestJson(url, {
    provider: 'europe_pmc',
    limiter: europePmcLimiter,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const resultList = record(record(value).resultList).result;
  const first = record(Array.isArray(resultList) ? resultList[0] : undefined);
  const abstract = typeof first.abstractText === 'string' ? cleanMarkup(first.abstractText) : '';
  return abstract.slice(0, 100_000);
}

/** arXiv：按 DOI 查 Atom 摘要。 */
export async function arxivAbstract(doi: string, options: SourceOptions = {}): Promise<string> {
  const url = new URL('https://export.arxiv.org/api/query');
  url.searchParams.set('search_query', `doi:${doi}`);
  url.searchParams.set('max_results', '1');
  const xml = await requestText(url, {
    provider: 'arxiv',
    limiter: arxivLimiter,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const summary = xml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || '';
  return cleanMarkup(summary).slice(0, 100_000);
}
