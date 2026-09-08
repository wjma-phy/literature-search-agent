/**
 * OA HTML 落地页的摘要抽取。
 * 移植自 Idea-Studio core/retrieval/providers.ts 的 safeOpenAccessUrl / htmlAbstract /
 * openAccessAbstract（只保留 HTML 路径；PDF 摘要抽取由 core/pdf 承担）。
 */

import { ProviderError, requestText } from '../ratelimit.js';

function cleanMarkup(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 只允许公网 https（防 SSRF 到 localhost/内网）。 */
export function safeOpenAccessUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || /^(localhost|127\.|0\.0\.0\.0|::1$)/i.test(url.hostname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** 从 HTML 中提取摘要：meta 标签 → JSON-LD description → abstract 区块。 */
export function htmlAbstract(value: string): string {
  const attribute = (tag: string, name: string) =>
    tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2];
  const meta = [...value.matchAll(/<meta\b[^>]*>/gi)].find((tag) => {
    const key = attribute(tag[0], 'name') || attribute(tag[0], 'property');
    return /^(?:citation_abstract|dc\.description|description|og:description)$/i.test(key || '');
  });
  const metaDescription = meta ? attribute(meta[0], 'content') : undefined;
  const jsonLdDescriptions = [...value.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .flatMap((match) => {
      try {
        const parsed = JSON.parse(match[1] ?? '') as unknown;
        const values = Array.isArray(parsed) ? parsed : [parsed];
        return values.flatMap((item) =>
          item && typeof item === 'object' && typeof (item as { description?: unknown }).description === 'string'
            ? [(item as { description: string }).description]
            : [],
        );
      } catch {
        return [];
      }
    });
  const section =
    value.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/i)?.[1] ||
    value.match(/<(?:section|div)[^>]+(?:class|id)=["'][^"']*abstract[^"']*["'][^>]*>([\s\S]*?)<\/(?:section|div)>/i)?.[1];
  return cleanMarkup(metaDescription || jsonLdDescriptions[0] || section || '');
}

const MAX_HTML_BYTES = 2_000_000;

/** 抓 OA 落地页并抽摘要；抓不到/没有摘要 → 空串，不抛（富集链会继续下行）。 */
export async function openAccessHtmlAbstract(
  pageUrl: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const url = safeOpenAccessUrl(pageUrl);
  if (!url) return '';
  const body = await requestText(url, {
    provider: 'open_access',
    maxAttempts: 1, // 落地页重试价值低，失败直接降级
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  }).catch((error: unknown) => {
    if (error instanceof ProviderError) return '';
    throw error;
  });
  if (!body || body.length > MAX_HTML_BYTES) return '';
  return htmlAbstract(body).slice(0, 100_000);
}
