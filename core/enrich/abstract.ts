/**
 * 摘要富集链：DOI（或标题）→ 多源兜底取摘要。
 * 移植自 Idea-Studio core/retrieval/providers.ts 的 enrichEvidenceAbstract。
 * 顺序：OpenAlex → Crossref →（S2 / EuropePMC / arXiv 并发，按此优先级取首个非空）
 *      → doi.org 落地页 HTML → Unpaywall OA 位置落地页。
 * 任何单源失败都不抛出，只降级到下一源；全部落空返回 status: 'missing'。
 */

import { normalizeDoi, titlesAlign } from '../dedupe.js';
import { lookupCrossrefByDoi, searchCrossref } from '../providers/crossref.js';
import { lookupOpenAlexByDoi, searchOpenAlex } from '../providers/openalex.js';
import { lookupS2ByDoi } from '../providers/semanticscholar.js';
import { lookupUnpaywall } from '../providers/unpaywall.js';
import { openAccessHtmlAbstract } from './html.js';
import { arxivAbstract, europePmcAbstract } from './sources.js';

export type AbstractSource =
  | 'openalex'
  | 'crossref'
  | 'semanticscholar'
  | 'europe_pmc'
  | 'arxiv'
  | 'open_access'
  | 'unpaywall'
  | '';

export interface EnrichInput {
  doi?: string;
  title: string;
  year?: number | null;
  authors?: string[];
}

export interface EnrichResult {
  abstract: string;
  source: AbstractSource;
  status: 'complete' | 'missing';
  /** 富集过程中解析出的 DOI（可能来自标题检索）；仍未知时为空串 */
  doi: string;
}

export interface EnrichOptions {
  /** OpenAlex API key（可选） */
  openAlexApiKey?: string;
  /** Semantic Scholar API key（可选） */
  s2ApiKey?: string;
  /** 联系邮箱：Crossref / Unpaywall / OpenAlex polite pool 共用（可选但强烈建议） */
  mailto?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function settled<T>(result: PromiseSettledResult<T | undefined>): T | undefined {
  return result.status === 'fulfilled' ? result.value : undefined;
}

/** 摘要富集主入口。永不因数据源失败而 throw。 */
export async function enrichAbstract(input: EnrichInput, options: EnrichOptions = {}): Promise<EnrichResult> {
  let doi = input.doi ? normalizeDoi(input.doi) : '';
  const fetchOpts = {
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const partials: Array<{ abstract: string; source: AbstractSource }> = [];

  // 0. 无 DOI：先按标题检索解析 DOI（OpenAlex + Crossref 并发，取标题对齐且带 DOI 者）
  if (!doi && input.title.trim()) {
    const [openalex, crossref] = await Promise.allSettled([
      searchOpenAlex(input.title, { limit: 3, ...fetchOpts }),
      searchCrossref(input.title, { limit: 3, ...(input.authors?.[0] ? { author: input.authors[0] } : {}), ...fetchOpts }),
    ]);
    const candidates = [...(settled(openalex)?.items ?? []), ...(settled(crossref)?.items ?? [])];
    const match = candidates.find((c) => c.doi && titlesAlign(c.title, input.title));
    if (match) {
      doi = match.doi;
      if (match.abstract) partials.push({ abstract: match.abstract, source: match.source as AbstractSource });
    }
  }
  if (!doi) return { abstract: '', source: '', status: 'missing', doi: '' };

  // 1-2. 元数据源：OpenAlex → Crossref
  const [openalex, crossref] = await Promise.allSettled([
    lookupOpenAlexByDoi(doi, { ...(options.openAlexApiKey ? { apiKey: options.openAlexApiKey } : {}), ...(options.mailto ? { mailto: options.mailto } : {}), ...fetchOpts }),
    lookupCrossrefByDoi(doi, { ...(options.mailto ? { mailto: options.mailto } : {}), ...fetchOpts }),
  ]);
  const openalexWork = settled(openalex);
  if (openalexWork?.abstract) return { abstract: openalexWork.abstract, source: 'openalex', status: 'complete', doi };
  const crossrefWork = settled(crossref);
  if (crossrefWork?.abstract) return { abstract: crossrefWork.abstract, source: 'crossref', status: 'complete', doi };

  // 3. 摘要专用源并发：S2 → EuropePMC → arXiv 优先级取首个非空
  const [s2, epmc, arxiv] = await Promise.allSettled([
    lookupS2ByDoi(doi, { ...(options.s2ApiKey ? { apiKey: options.s2ApiKey } : {}), ...fetchOpts }).then((w) => w?.abstract ?? ''),
    europePmcAbstract(doi, fetchOpts),
    arxivAbstract(doi, fetchOpts),
  ]);
  const priority: Array<{ result: PromiseSettledResult<string>; source: AbstractSource }> = [
    { result: s2, source: 'semanticscholar' },
    { result: epmc, source: 'europe_pmc' },
    { result: arxiv, source: 'arxiv' },
  ];
  for (const { result, source } of priority) {
    const abstract = settled(result);
    if (abstract) return { abstract, source, status: 'complete', doi };
  }

  // 4. doi.org 落地页 HTML
  const landing = await openAccessHtmlAbstract(`https://doi.org/${encodeURIComponent(doi)}`, fetchOpts).catch(() => '');
  if (landing) return { abstract: landing, source: 'open_access', status: 'complete', doi };

  // 5. Unpaywall OA 位置落地页
  if (options.mailto) {
    const unpaywall = await lookupUnpaywall(doi, { email: options.mailto, ...fetchOpts }).catch(() => undefined);
    for (const location of unpaywall?.locations ?? []) {
      const abstract = await openAccessHtmlAbstract(location.landingUrl || location.pdfUrl, fetchOpts).catch(() => '');
      if (abstract) return { abstract, source: 'unpaywall', status: 'complete', doi };
    }
  }

  // 6. 标题检索时攒下的部分摘要兜底
  const best = partials.sort((a, b) => b.abstract.length - a.abstract.length)[0];
  if (best) return { abstract: best.abstract, source: best.source, status: 'complete', doi };
  return { abstract: '', source: '', status: 'missing', doi };
}
