import { describe, expect, it } from 'vitest';
import { enrichAbstract } from '../core/enrich/abstract.js';

const DOI = '10.1063/1.5086934';

function openAlexWorkWithAbstract(abstract: string | null): Record<string, unknown> {
  const work: Record<string, unknown> = {
    id: 'https://openalex.org/W1',
    doi: `https://doi.org/${DOI}`,
    title: 'Plasma ion acceleration study',
    publication_year: 2019,
  };
  if (abstract !== null) {
    // 构造倒排索引：["Hello", "plasma", "world"] → Hello plasma world
    const words = abstract.split(' ');
    const index: Record<string, number[]> = {};
    words.forEach((word, i) => { index[word] = [i]; });
    work.abstract_inverted_index = index;
  }
  return work;
}

interface FakeConfig {
  openAlexWork?: Record<string, unknown> | null;
  openAlexSearch?: Array<Record<string, unknown>>;
  crossrefMessage?: Record<string, unknown> | null;
  crossrefSearch?: Array<Record<string, unknown>>;
  s2Paper?: Record<string, unknown> | null;
  epmcAbstract?: string;
  arxivSummary?: string;
  landingHtml?: string;
  unpaywall?: Record<string, unknown> | null;
}

function fakeFetch(config: FakeConfig): { fetchImpl: typeof fetch; hits: string[] } {
  const hits: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const text = (body: string, status = 200) =>
    new Response(body, { status, headers: { 'content-type': 'text/html' } });

  const impl = async (input: URL | string | Request): Promise<Response> => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    hits.push(url.hostname + url.pathname);

    if (url.hostname === 'api.openalex.org') {
      if (url.pathname.startsWith('/works/doi:')) {
        return config.openAlexWork ? json(config.openAlexWork) : json({}, 404);
      }
      return json({ results: config.openAlexSearch ?? [] });
    }
    if (url.hostname === 'api.crossref.org') {
      if (url.pathname.startsWith('/works/')) {
        return config.crossrefMessage ? json({ message: config.crossrefMessage }) : json({}, 404);
      }
      return json({ message: { items: config.crossrefSearch ?? [] } });
    }
    if (url.hostname === 'api.semanticscholar.org') {
      return config.s2Paper ? json(config.s2Paper) : json({}, 404);
    }
    if (url.hostname === 'www.ebi.ac.uk') {
      return json({ resultList: { result: config.epmcAbstract ? [{ abstractText: config.epmcAbstract }] : [] } });
    }
    if (url.hostname === 'export.arxiv.org') {
      return text(config.arxivSummary ? `<feed><entry><summary>${config.arxivSummary}</summary></entry></feed>` : '<feed></feed>');
    }
    if (url.hostname === 'doi.org') {
      return text(config.landingHtml ?? '<html><body>no abstract</body></html>');
    }
    if (url.hostname === 'api.unpaywall.org') {
      return config.unpaywall ? json(config.unpaywall) : json({}, 404);
    }
    return json({}, 404);
  };
  return { fetchImpl: impl as unknown as typeof fetch, hits };
}

const fastAuth = { mailto: 'me@example.org', s2ApiKey: 'K', openAlexApiKey: 'K' };

describe('enrichAbstract', () => {
  it('OpenAlex 有摘要 → 直接命中，不调用下游源', async () => {
    const { fetchImpl, hits } = fakeFetch({ openAlexWork: openAlexWorkWithAbstract('Hello plasma world') });
    const result = await enrichAbstract({ doi: DOI, title: 'Plasma ion acceleration study' }, { ...fastAuth, fetchImpl });
    expect(result).toMatchObject({ status: 'complete', source: 'openalex', abstract: 'Hello plasma world', doi: DOI });
    expect(hits.some((h) => h.includes('semanticscholar'))).toBe(false);
    expect(hits.some((h) => h.includes('ebi.ac.uk'))).toBe(false);
  });

  it('元数据源无摘要 → S2 兜底', async () => {
    const { fetchImpl } = fakeFetch({
      openAlexWork: openAlexWorkWithAbstract(null),
      crossrefMessage: { title: ['Plasma ion acceleration study'], DOI },
      s2Paper: { title: 'Plasma ion acceleration study', abstract: 'S2 abstract here.', externalIds: { DOI } },
    });
    const result = await enrichAbstract({ doi: DOI, title: 'Plasma ion acceleration study' }, { ...fastAuth, fetchImpl });
    expect(result).toMatchObject({ status: 'complete', source: 'semanticscholar', abstract: 'S2 abstract here.' });
  }, 15_000);

  it('S2 也没有 → EuropePMC 兜底', async () => {
    const { fetchImpl } = fakeFetch({
      openAlexWork: openAlexWorkWithAbstract(null),
      crossrefMessage: null,
      s2Paper: null,
      epmcAbstract: 'EPMC abstract text.',
    });
    const result = await enrichAbstract({ doi: DOI, title: 'Plasma ion acceleration study' }, { ...fastAuth, fetchImpl });
    expect(result).toMatchObject({ status: 'complete', source: 'europe_pmc', abstract: 'EPMC abstract text.' });
  }, 15_000);

  it('全链路落空 → missing（arXiv / 落地页 / Unpaywall 都试过）', async () => {
    const { fetchImpl, hits } = fakeFetch({
      openAlexWork: openAlexWorkWithAbstract(null),
      unpaywall: { is_oa: true, best_oa_location: { url_for_landing_page: 'https://doi.org/x' }, oa_locations: [] },
    });
    const result = await enrichAbstract({ doi: DOI, title: 'Plasma ion acceleration study' }, { ...fastAuth, fetchImpl });
    expect(result.status).toBe('missing');
    expect(hits.some((h) => h.includes('arxiv'))).toBe(true);
    expect(hits.some((h) => h.includes('unpaywall'))).toBe(true);
  }, 30_000);

  it('无 DOI：标题检索解析出 DOI，全链路落空时用检索到的摘要兜底', async () => {
    const { fetchImpl } = fakeFetch({
      openAlexSearch: [openAlexWorkWithAbstract('Abstract found during title search')],
      openAlexWork: openAlexWorkWithAbstract(null), // lookup 阶段反而没摘要
    });
    const result = await enrichAbstract({ title: 'Plasma ion acceleration study' }, { ...fastAuth, fetchImpl });
    expect(result.status).toBe('complete');
    expect(result.abstract).toBe('Abstract found during title search');
    expect(result.doi).toBe(DOI);
  }, 30_000);

  it('无 DOI 且标题检索无果 → missing', async () => {
    const { fetchImpl } = fakeFetch({});
    const result = await enrichAbstract({ title: 'Completely unknown paper title xyz' }, { ...fastAuth, fetchImpl });
    expect(result).toEqual({ abstract: '', source: '', status: 'missing', doi: '' });
  }, 15_000);

  it('doi.org 落地页 HTML 兜底（meta description）', async () => {
    const { fetchImpl } = fakeFetch({
      openAlexWork: openAlexWorkWithAbstract(null),
      landingHtml: '<html><head><meta name="description" content="Landing page abstract."></head></html>',
    });
    const result = await enrichAbstract({ doi: DOI, title: 'Plasma ion acceleration study' }, { ...fastAuth, fetchImpl });
    expect(result).toMatchObject({ status: 'complete', source: 'open_access', abstract: 'Landing page abstract.' });
  }, 30_000);
});
