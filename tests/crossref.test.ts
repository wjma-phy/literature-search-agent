import { describe, expect, it, vi } from 'vitest';
import { cleanCrossrefAbstract, lookupCrossrefByDoi, mapCrossrefWork, searchCrossref } from '../core/providers/crossref.js';

function sampleMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: ['Plasma ion acceleration study'],
    author: [
      { given: 'Alice', family: 'Smith' },
      { given: 'Bob', family: 'Jones' },
    ],
    published: { 'date-parts': [[2019, 5, 1]] },
    'container-title': ['Physics of Plasmas'],
    DOI: '10.1063/1.5086934',
    URL: 'https://doi.org/10.1063/1.5086934',
    'is-referenced-by-count': 57,
    abstract: '<jats:p>We report &lt;b&gt;ion&lt;/b&gt; acceleration.</jats:p>',
    link: [
      { URL: 'http://example.org/fulltext.pdf', 'content-type': 'application/pdf' },
      { URL: 'https://example.org/page', 'content-type': 'text/html' },
    ],
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

describe('cleanCrossrefAbstract', () => {
  it('去 JATS 标签并解码实体', () => {
    expect(cleanCrossrefAbstract('<jats:p>A &amp; B &lt;ok&gt;</jats:p>')).toBe('A & B <ok>');
  });
  it('空值 → 空串', () => {
    expect(cleanCrossrefAbstract(undefined)).toBe('');
  });
});

describe('mapCrossrefWork', () => {
  it('映射全部字段', () => {
    const item = mapCrossrefWork(sampleMessage());
    expect(item).toMatchObject({
      title: 'Plasma ion acceleration study',
      authors: ['Alice Smith', 'Bob Jones'],
      year: 2019,
      venue: 'Physics of Plasmas',
      doi: '10.1063/1.5086934',
      citationCount: 57,
      abstract: 'We report <b>ion</b> acceleration.',
      abstractStatus: 'complete',
      source: 'crossref',
    });
  });

  it('link 中的 PDF 直链 → oaPdfUrl（http 升级为 https）', () => {
    expect(mapCrossrefWork(sampleMessage())?.oaPdfUrl).toBe('https://example.org/fulltext.pdf');
  });

  it('无标题 → undefined；无摘要 → pending', () => {
    expect(mapCrossrefWork(sampleMessage({ title: [] }))).toBeUndefined();
    expect(mapCrossrefWork(sampleMessage({ abstract: undefined }))?.abstractStatus).toBe('pending');
  });
});

describe('searchCrossref', () => {
  it('拼对 URL：query.bibliographic + rows + mailto + filter 年份', async () => {
    const { fetchImpl, calls } = fetchReturning({ message: { items: [sampleMessage()] } });
    const result = await searchCrossref('ion acceleration', {
      limit: 5, author: 'Smith', yearFrom: 2015, yearTo: 2020, mailto: 'me@example.org', fetchImpl,
    });
    const params = calls[0]!.searchParams;
    expect(params.get('query.bibliographic')).toBe('ion acceleration');
    expect(params.get('query.author')).toBe('Smith');
    expect(params.get('rows')).toBe('5');
    expect(params.get('mailto')).toBe('me@example.org');
    expect(params.get('filter')).toBe('from-pub-date:2015-01-01,until-pub-date:2020-12-31');
    expect(result.diagnostics.crossref).toEqual({ ok: true, count: 1 });
  });

  it('fetch 持续失败 → diagnostics.ok=false', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500)) as unknown as typeof fetch;
    const result = await searchCrossref('q', { fetchImpl });
    expect(result.diagnostics.crossref?.ok).toBe(false);
  }, 15_000);
});

describe('lookupCrossrefByDoi', () => {
  it('按 DOI 查单篇', async () => {
    const { fetchImpl, calls } = fetchReturning({ message: sampleMessage() });
    const item = await lookupCrossrefByDoi('10.1063/1.5086934', { fetchImpl });
    expect(calls[0]!.pathname).toBe('/works/10.1063%2F1.5086934');
    expect(item?.title).toBe('Plasma ion acceleration study');
  });

  it('404 → undefined', async () => {
    const { fetchImpl } = fetchReturning({}, 404);
    expect(await lookupCrossrefByDoi('10.1/x', { fetchImpl })).toBeUndefined();
  });
});
