import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { downloadPdf } from '../core/pdf/download.js';
import { extractPdfText } from '../core/pdf/extract.js';

/** 手工构造的最小合法 PDF（含一行文本），pdf.js 可容错解析缺失的 xref。 */
function minimalPdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  objects.forEach((body, i) => {
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  pdf += 'trailer\n<</Root 1 0 R>>\n%%EOF';
  return new TextEncoder().encode(pdf);
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lit-search-pdf-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('downloadPdf', () => {
  it('下载并落盘，校验魔数', async () => {
    const bytes = minimalPdf('Hello');
    const fetchImpl = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.byteLength) },
    })) as unknown as typeof fetch;
    const dest = join(dir, 'ok.pdf');
    const result = await downloadPdf('http://example.org/paper.pdf', dest, { fetchImpl });
    expect(result.bytes).toBe(bytes.byteLength);
    expect(new URL(result.url).protocol).toBe('https:'); // http 自动升级
    expect(new Uint8Array(await readFile(dest)).slice(0, 5)).toEqual(new TextEncoder().encode('%PDF-'));
  });

  it('HTML 响应（登录墙）→ 415', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>login</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch;
    await expect(downloadPdf('https://example.org/paper.pdf', join(dir, 'x.pdf'), { fetchImpl }))
      .rejects.toMatchObject({ code: 'bad_request', status: 415 });
  });

  it('content-length 超限 → 413', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'content-length': '99999999' },
    })) as unknown as typeof fetch;
    await expect(downloadPdf('https://example.org/big.pdf', join(dir, 'big.pdf'), { fetchImpl }))
      .rejects.toMatchObject({ status: 413 });
  });

  it('HTTP 404 → provider_unavailable', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadPdf('https://example.org/missing.pdf', join(dir, 'm.pdf'), { fetchImpl }))
      .rejects.toMatchObject({ code: 'provider_unavailable', status: 404 });
  });

  it('localhost URL → bad_request（SSRF 防护）', async () => {
    await expect(downloadPdf('https://localhost/x.pdf', join(dir, 'l.pdf'))).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('extractPdfText', () => {
  it('提取最小 PDF 的文本', async () => {
    const result = await extractPdfText(minimalPdf('Hello literature agent'));
    expect(result.text).toContain('Hello literature agent');
    expect(result.pageCount).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('maxChars 截断并置 truncated', async () => {
    const result = await extractPdfText(minimalPdf('Hello literature agent'), { maxChars: 5 });
    expect(result.text).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('从文件路径读取', async () => {
    const dest = join(dir, 'extract.pdf');
    const fetchImpl = vi.fn(async () => new Response(minimalPdf('From file path'), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    })) as unknown as typeof fetch;
    await downloadPdf('https://example.org/p.pdf', dest, { fetchImpl });
    const result = await extractPdfText(dest);
    expect(result.text).toContain('From file path');
  });

  it('外部提取器注入口生效', async () => {
    const result = await extractPdfText(new Uint8Array([1, 2, 3]), {
      extractor: async () => ({ text: 'external extractor output', pageCount: 9, parsedPages: 9 }),
    });
    expect(result.text).toBe('external extractor output');
    expect(result.pageCount).toBe(9);
  });
});
