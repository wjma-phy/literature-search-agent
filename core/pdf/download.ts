/**
 * PDF 下载：URL → 本地文件。
 * 安全约束：仅 https（http 自动升级）、30MB 上限、校验 %PDF 魔数或 content-type。
 */

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProviderError } from '../ratelimit.js';

const MAX_PDF_BYTES = 30_000_000;

export interface DownloadResult {
  path: string;
  bytes: number;
  /** 实际请求的 URL（http 可能已升级为 https） */
  url: string;
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function normalizePdfUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError(`无效的 PDF URL：${value}`, 'bad_request', false, 400);
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || /^(localhost|127\.|0\.0\.0\.0|::1$)/i.test(url.hostname)) {
    throw new ProviderError(`不允许的 PDF URL：${value}`, 'bad_request', false, 400);
  }
  return url;
}

/** 下载 PDF 到本地路径。返回字节数与落盘路径。 */
export async function downloadPdf(pdfUrl: string, destPath: string, options: DownloadOptions = {}): Promise<DownloadResult> {
  const url = normalizePdfUrl(pdfUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/pdf',
      'User-Agent': 'literature-search-agent/0.1 (https://github.com/literature-search-agent)',
    },
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000),
  }).catch((error: unknown) => {
    throw new ProviderError(
      `PDF 下载连接失败：${error instanceof Error ? error.message : String(error)}`,
      'provider_unavailable',
      true,
    );
  });
  if (!response.ok) {
    throw new ProviderError(`PDF 下载失败（HTTP ${response.status}）。`, 'provider_unavailable', response.status >= 500, response.status);
  }

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_PDF_BYTES) {
    throw new ProviderError(`PDF 过大（${declared} 字节，上限 ${MAX_PDF_BYTES}）。`, 'bad_request', false, 413);
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType && !/application\/pdf|application\/octet-stream|binary/i.test(contentType) && !/\.pdf(?:$|[?#])/i.test(url.pathname)) {
    throw new ProviderError(`响应不是 PDF（content-type: ${contentType}）。`, 'bad_request', false, 415);
  }
  if (!response.body) throw new ProviderError('PDF 响应无 body。', 'provider_unavailable', true);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new ProviderError(`PDF 过大（${bytes.byteLength} 字节，上限 ${MAX_PDF_BYTES}）。`, 'bad_request', false, 413);
  }
  // 魔数校验：%PDF-
  const magic = new TextDecoder().decode(bytes.slice(0, 5));
  if (magic !== '%PDF-') {
    throw new ProviderError('响应内容不是 PDF（缺少 %PDF- 魔数，可能是 HTML 登录墙）。', 'bad_request', false, 415);
  }

  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, bytes);
  return { path: destPath, bytes: bytes.byteLength, url: url.toString() };
}

/** 流式下载变体（大文件、进度友好）；当前 CLI 用 downloadPdf 即可，留作后续扩展。 */
export async function streamPdfToFile(pdfUrl: string, destPath: string): Promise<void> {
  const url = normalizePdfUrl(pdfUrl);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new ProviderError(`PDF 下载失败（HTTP ${response.status}）。`, 'provider_unavailable', response.status >= 500, response.status);
  await mkdir(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(destPath));
}
