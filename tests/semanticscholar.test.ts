import { describe, expect, it, vi } from 'vitest';
import { lookupS2ByDoi, mapS2Paper, searchSemanticScholar } from '../core/providers/semanticscholar.js';

function samplePaper(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paperId: 'abc123',
    title: 'Laser-driven ion acceleration',
    authors: [{ name: 'Alice Smith' }, { name: 'Bob Jones' }],
    year: 2020,
    venue: 'Physics of Plasmas',
    externalIds: { DOI: '10.1063/5.0000001', ArXiv: '2001.00001' },
    abstract: 'We  study   ion acceleration.',
    citationCount: 123,
    openAccessPdf: { url: 'https://example.org/paper.pdf' },
    url: 'https://www.semanticscholar.org/paper/abc123',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetchReturning(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: Array<{ url: URL; headers: Record<string, string> }> } {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const impl = vi.fn(async (url: URL, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return jsonResponse(body, status);
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

describe('mapS2Paper', () => {
  it('映射全部字段，摘要空白折叠', () => {
    const item = mapS2Paper(samplePaper());
    expect(item).toMatchObject({
      title: 'Laser-driven ion acceleration',
      authors: ['Alice Smith', 'Bob Jones'],
      year: 2020,
      venue: 'Physics of Plasmas',
      doi: '10.1063/5.0000001',
      citationCount: 123,
      abstract: 'We study ion acceleration.',
      abstractStatus: 'complete',
      oaPdfUrl: 'https://example.org/paper.pdf',
      source: 'semanticscholar',
    });
    expect(item?.externalIds).toEqual({ s2: 'abc123', doi: '10.1063/5.0000001', arxiv: '2001.00001' });
  });

  it('无标题 → undefined；无摘要 → pending', () => {
    expect(mapS2Paper(samplePaper({ title: '' }))).toBeUndefined();
    expect(mapS2Paper(samplePaper({ abstract: null }))?.abstractStatus).toBe('pending');
  });
});

describe('searchSemanticScholar', () => {
  it('拼对 URL：query + limit + fields + year', async () => {
    const { fetchImpl, calls } = fetchReturning({ data: [samplePaper()] });
    const result = await searchSemanticScholar('ion acceleration', { limit: 5, yearFrom: 2018, yearTo: 2022, fetchImpl });
    const params = calls[0]!.url.searchParams;
    expect(calls[0]!.url.pathname).toBe('/graph/v1/paper/search');
    expect(params.get('query')).toBe('ion acceleration');
    expect(params.get('limit')).toBe('5');
    expect(params.get('year')).toBe('2018-2022');
    expect(params.get('fields')).toContain('abstract');
    expect(result.diagnostics.semanticscholar).toEqual({ ok: true, count: 1 });
  });

  it('有 apiKey → 带 x-api-key 头', async () => {
    const { fetchImpl, calls } = fetchReturning({ data: [] });
    await searchSemanticScholar('q', { apiKey: 'S2KEY', fetchImpl });
    expect(calls[0]!.headers['x-api-key']).toBe('S2KEY');
  });

  it('429 持续失败 → diagnostics.ok=false（不向上抛）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429, )) as unknown as typeof fetch;
    const result = await searchSemanticScholar('q', { fetchImpl });
    expect(result.items).toEqual([]);
    expect(result.diagnostics.semanticscholar?.ok).toBe(false);
  }, 15_000);

  it('空检索词 → bad_request', async () => {
    await expect(searchSemanticScholar(' ')).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('lookupS2ByDoi', () => {
  it('按 DOI 查单篇，URL 形如 /paper/DOI:<normalized>', async () => {
    const { fetchImpl, calls } = fetchReturning(samplePaper());
    const item = await lookupS2ByDoi('10.1063/5.0000001', { fetchImpl });
    expect(calls[0]!.url.pathname).toBe('/graph/v1/paper/DOI:10.1063%2F5.0000001');
    expect(item?.doi).toBe('10.1063/5.0000001');
  });

  it('404 → undefined', async () => {
    const { fetchImpl } = fetchReturning({}, 404);
    expect(await lookupS2ByDoi('10.1/x', { fetchImpl })).toBeUndefined();
  });
});
