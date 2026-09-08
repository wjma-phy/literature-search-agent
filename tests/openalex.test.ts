import { describe, expect, it, vi } from 'vitest';
import {
  citedByOpenAlex,
  invertOpenAlexAbstract,
  lookupOpenAlexByDoi,
  mapOpenAlexWork,
  searchOpenAlex,
} from '../core/providers/openalex.js';

/** 一份尽量贴近真实的 OpenAlex work JSON。 */
function sampleWork(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'https://openalex.org/W2741809807',
    doi: 'https://doi.org/10.1038/NATURE12373',
    title: 'Plasma channel ion acceleration',
    display_name: 'Plasma channel ion acceleration',
    publication_year: 2013,
    cited_by_count: 42,
    authorships: [
      { author: { display_name: 'Alice Smith' } },
      { author: { display_name: 'Bob Jones' } },
      { author: { display_name: 'Alice Smith' } }, // 重复作者应去重
    ],
    primary_location: {
      landing_page_url: 'https://www.nature.com/articles/nature12373',
      pdf_url: null,
      source: { display_name: 'Nature' },
    },
    best_oa_location: { pdf_url: 'https://example.org/paper.pdf' },
    abstract_inverted_index: {
      We: [0],
      demonstrate: [1],
      ion: [2, 5],
      acceleration: [3],
      in: [4],
      channels: [6],
    },
    ids: {
      openalex: 'https://openalex.org/W2741809807',
      doi: 'https://doi.org/10.1038/nature12373',
      mag: '2741809807',
      pmid: 'https://pubmed.ncbi.nlm.nih.gov/23803884',
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchReturning(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: URL[] } {
  const calls: URL[] = [];
  const impl = vi.fn(async (url: URL) => {
    calls.push(url);
    return jsonResponse(body, status);
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

describe('invertOpenAlexAbstract', () => {
  it('倒排索引还原为有序文本', () => {
    expect(invertOpenAlexAbstract({ hello: [0], brave: [1], new: [2], world: [3] })).toBe('hello brave new world');
  });
  it('空/缺失索引返回空串', () => {
    expect(invertOpenAlexAbstract(null)).toBe('');
    expect(invertOpenAlexAbstract(undefined)).toBe('');
    expect(invertOpenAlexAbstract({})).toBe('');
  });
});

describe('mapOpenAlexWork', () => {
  it('映射全部字段', () => {
    const item = mapOpenAlexWork(sampleWork());
    expect(item).toMatchObject({
      title: 'Plasma channel ion acceleration',
      authors: ['Alice Smith', 'Bob Jones'],
      year: 2013,
      venue: 'Nature',
      doi: '10.1038/nature12373',
      url: 'https://www.nature.com/articles/nature12373',
      citationCount: 42,
      abstract: 'We demonstrate ion acceleration in ion channels',
      abstractStatus: 'complete',
      oaPdfUrl: 'https://example.org/paper.pdf',
      source: 'openalex',
    });
    expect(item?.externalIds).toEqual({
      openalex: 'https://openalex.org/W2741809807',
      doi: '10.1038/nature12373',
      mag: '2741809807',
      pmid: 'https://pubmed.ncbi.nlm.nih.gov/23803884',
    });
  });

  it('无摘要 → abstractStatus pending', () => {
    const item = mapOpenAlexWork(sampleWork({ abstract_inverted_index: null }));
    expect(item?.abstract).toBe('');
    expect(item?.abstractStatus).toBe('pending');
  });

  it('无 best_oa_location 时退回 primary_location.pdf_url', () => {
    const item = mapOpenAlexWork(sampleWork({
      best_oa_location: null,
      primary_location: { pdf_url: 'https://example.org/primary.pdf', source: { display_name: 'J' } },
    }));
    expect(item?.oaPdfUrl).toBe('https://example.org/primary.pdf');
  });

  it('无标题 → undefined', () => {
    expect(mapOpenAlexWork(sampleWork({ title: '', display_name: '  ' }))).toBeUndefined();
  });

  it('无 DOI / 无被引 → 空串与 null', () => {
    const item = mapOpenAlexWork(sampleWork({ doi: null, cited_by_count: null, ids: {} }));
    expect(item?.doi).toBe('');
    expect(item?.citationCount).toBeNull();
    expect(item?.externalIds).toEqual({ openalex: 'https://openalex.org/W2741809807' });
  });
});

describe('searchOpenAlex', () => {
  it('拼对 URL：search + per_page + mailto；结果映射并去重', async () => {
    const { fetchImpl, calls } = fetchReturning({
      results: [sampleWork(), sampleWork(), sampleWork({ id: 'https://openalex.org/W999', doi: null, title: 'Other paper' })],
    });
    const result = await searchOpenAlex('plasma channel ion acceleration', { limit: 10, mailto: 'me@example.org', fetchImpl });
    expect(calls[0]?.searchParams.get('search')).toBe('plasma channel ion acceleration');
    expect(calls[0]?.searchParams.get('per_page')).toBe('10');
    expect(calls[0]?.searchParams.get('mailto')).toBe('me@example.org');
    expect(calls[0]?.searchParams.get('api_key')).toBeNull();
    expect(result.diagnostics.openalex).toEqual({ ok: true, count: 2 });
    expect(result.items.map((i) => i.title)).toEqual(['Plasma channel ion acceleration', 'Other paper']);
  });

  it('apiKey 优先于 mailto', async () => {
    const { fetchImpl, calls } = fetchReturning({ results: [] });
    await searchOpenAlex('q', { apiKey: 'KEY123', mailto: 'me@example.org', fetchImpl });
    expect(calls[0]?.searchParams.get('api_key')).toBe('KEY123');
    expect(calls[0]?.searchParams.get('mailto')).toBeNull();
  });

  it('匿名档：既无 api_key 也无 mailto', async () => {
    const { fetchImpl, calls } = fetchReturning({ results: [] });
    await searchOpenAlex('q', { fetchImpl });
    expect(calls[0]?.searchParams.get('api_key')).toBeNull();
    expect(calls[0]?.searchParams.get('mailto')).toBeNull();
  });

  it('yearFrom/yearTo → filter=publication_year:from-to', async () => {
    const { fetchImpl, calls } = fetchReturning({ results: [] });
    await searchOpenAlex('q', { yearFrom: 2015, yearTo: 2020, fetchImpl });
    expect(calls[0]?.searchParams.get('filter')).toBe('publication_year:2015-2020');
  });

  it('仅 yearFrom / 仅 yearTo', async () => {
    const a = fetchReturning({ results: [] });
    await searchOpenAlex('q', { yearFrom: 2015, fetchImpl: a.fetchImpl });
    expect(a.calls[0]?.searchParams.get('filter')).toBe('publication_year:>2014');
    const b = fetchReturning({ results: [] });
    await searchOpenAlex('q', { yearTo: 2020, fetchImpl: b.fetchImpl });
    expect(b.calls[0]?.searchParams.get('filter')).toBe('publication_year:<2021');
  });

  it('空检索词 → bad_request', async () => {
    await expect(searchOpenAlex('   ')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('无标题条目被丢弃', async () => {
    const { fetchImpl } = fetchReturning({ results: [sampleWork({ title: '' }), sampleWork()] });
    const result = await searchOpenAlex('q', { fetchImpl });
    expect(result.items).toHaveLength(1);
  });

  it('fetch 持续失败 → items 为空 + diagnostics.ok=false（不向上抛）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    const result = await searchOpenAlex('q', { fetchImpl });
    expect(result.items).toEqual([]);
    expect(result.diagnostics.openalex?.ok).toBe(false);
    expect(result.diagnostics.openalex?.error).toContain('500');
  }, 10_000);
});

describe('lookupOpenAlexByDoi', () => {
  it('按 DOI 查单篇，URL 形如 /works/doi:<normalized>', async () => {
    const { fetchImpl, calls } = fetchReturning(sampleWork());
    const item = await lookupOpenAlexByDoi('https://doi.org/10.1038/NATURE12373', { fetchImpl });
    expect(calls[0]?.pathname).toBe('/works/doi:10.1038%2Fnature12373');
    expect(item?.doi).toBe('10.1038/nature12373');
  });

  it('404 → undefined', async () => {
    const { fetchImpl } = fetchReturning({}, 404);
    expect(await lookupOpenAlexByDoi('10.1/nonexistent', { fetchImpl })).toBeUndefined();
  });

  it('空 DOI → bad_request', async () => {
    await expect(lookupOpenAlexByDoi('')).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('citedByOpenAlex', () => {
  it('DOI 先 lookup 解析 id，再 filter=cites:<id>', async () => {
    const calls: URL[] = [];
    const fetchImpl = vi.fn(async (url: URL) => {
      calls.push(url);
      if (url.pathname.startsWith('/works/doi:')) return jsonResponse(sampleWork());
      return jsonResponse({ results: [sampleWork({ id: 'https://openalex.org/W1', title: 'Citing paper', doi: null })] });
    }) as unknown as typeof fetch;
    const result = await citedByOpenAlex('10.1038/nature12373', { limit: 5, fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.pathname).toBe('/works/doi:10.1038%2Fnature12373');
    expect(calls[1]?.searchParams.get('filter')).toBe('cites:https://openalex.org/W2741809807');
    expect(calls[1]?.searchParams.get('per_page')).toBe('5');
    expect(result.diagnostics.openalex).toEqual({ ok: true, count: 1 });
  });

  it('直接传 OpenAlex id 时跳过 lookup', async () => {
    const { fetchImpl, calls } = fetchReturning({ results: [] });
    await citedByOpenAlex('W2741809807', { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.searchParams.get('filter')).toBe('cites:W2741809807');
  });

  it('DOI 无法解析 → diagnostics.ok=false', async () => {
    const { fetchImpl } = fetchReturning({}, 404);
    const result = await citedByOpenAlex('10.1/unknown', { fetchImpl });
    expect(result.items).toEqual([]);
    expect(result.diagnostics.openalex?.ok).toBe(false);
    expect(result.diagnostics.openalex?.error).toContain('无法解析');
  });
});
