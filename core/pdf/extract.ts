/**
 * PDF 全文提取：pdf-parse v2（pdfjs 内核，纯 JS/TS，无 Python 依赖）。
 * 支持截断（maxPages / maxChars），供 Agent 场景防上下文爆炸。
 * 设计保留了外部提取器注入口：extractPdfText 的 extractor 参数可替换为 PyMuPDF 等。
 */

import { readFile } from 'node:fs/promises';
import { PDFParse } from 'pdf-parse';

export interface ExtractOptions {
  /** 最多解析页数（默认全部） */
  maxPages?: number;
  /** 返回文本字符数上限（默认 200_000；超出截断并置 truncated） */
  maxChars?: number;
  /** 外部提取器注入点（默认 pdf-parse） */
  extractor?: PdfExtractor;
}

export interface ExtractResult {
  text: string;
  /** PDF 总页数 */
  pageCount: number;
  /** 实际解析的页数 */
  parsedPages: number;
  /** 文本是否因 maxChars 被截断 */
  truncated: boolean;
}

export type PdfExtractor = (data: Uint8Array, maxPages?: number) => Promise<{ text: string; pageCount: number; parsedPages: number }>;

const DEFAULT_MAX_CHARS = 200_000;

async function pdfParseExtract(data: Uint8Array, maxPages?: number): Promise<{ text: string; pageCount: number; parsedPages: number }> {
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText(maxPages ? { first: maxPages } : {});
    return { text: result.text, pageCount: result.total, parsedPages: result.pages.length };
  } finally {
    await parser.destroy();
  }
}

/**
 * 提取 PDF 文本。input 为本地路径或字节数组。
 * 扫描版 PDF（无文本层）会返回空 text —— 调用方据此降级。
 */
export async function extractPdfText(input: string | Uint8Array, options: ExtractOptions = {}): Promise<ExtractResult> {
  const data = typeof input === 'string' ? new Uint8Array(await readFile(input)) : input;
  const extractor = options.extractor ?? pdfParseExtract;
  const { text, pageCount, parsedPages } = await extractor(data, options.maxPages);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const truncated = text.length > maxChars;
  return {
    text: truncated ? text.slice(0, maxChars) : text,
    pageCount,
    parsedPages,
    truncated,
  };
}
