import { describe, expect, it, vi } from 'vitest';
import { lookupUnpaywall } from '../core/providers/unpaywall.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('lookupUnpaywall', () => {
  it('映射 best_oa_location 与 oa_locations，去重', async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      expect(url.pathname).toBe('/v2/10.1038%2Fnature12373');
      expect(url.searchParams.get('email')).toBe('me@example.org');
      return jsonResponse({
        doi: '10.1038/nature12373',
        is_oa: true,
        best_oa_location: { url_for_pdf: 'https://example.org/best.pdf', url_for_landing_page: 'https://example.org/landing', host_type: 'repository', license: 'cc-by' },
        oa_locations: [
          { url_for_pdf: 'https://example.org/best.pdf', url_for_landing_page: 'https://example.org/landing', host_type: 'repository', license: 'cc-by' },
          { url_for_pdf: 'https://other.org/alt.pdf', url_for_landing_page: 'https://other.org/', host_type: 'publisher', license: null },
        ],
      });
    }) as unknown as typeof fetch;

    const record = await lookupUnpaywall('10.1038/nature12373', { email: 'me@example.org', fetchImpl });
    expect(record?.isOa).toBe(true);
    expect(record?.bestPdfUrl).toBe('https://example.org/best.pdf');
    expect(record?.locations).toHaveLength(2);
    expect(record?.locations[0]?.isBest).toBe(true);
    expect(record?.locations[1]?.pdfUrl).toBe('https://other.org/alt.pdf');
  });

  it('404（未收录）→ undefined', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 404)) as unknown as typeof fetch;
    expect(await lookupUnpaywall('10.1/x', { email: 'me@example.org', fetchImpl })).toBeUndefined();
  });

  it('缺 email → bad_request', async () => {
    await expect(lookupUnpaywall('10.1/x')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('空 DOI → bad_request', async () => {
    await expect(lookupUnpaywall('', { email: 'me@example.org' })).rejects.toMatchObject({ code: 'bad_request' });
  });
});
