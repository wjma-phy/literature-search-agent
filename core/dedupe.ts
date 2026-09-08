/**
 * DOI / 标题归一化与去重。
 * 移植自 Idea-Studio core/retrieval/providers.ts（normalizeDoi / extractDoi /
 * foldForMatch / titlesAlign / dedupeMetadata），key 逻辑适配本仓 WorkItem。
 */

import type { WorkItem } from './types.js';

/** 归一化 DOI：去 URL/`doi:` 前缀、尾部标点，小写；无法归一化时返回空串。 */
export function normalizeDoi(value: string): string {
  return decodeURIComponent(value.trim())
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[\s.,;:)>\]}]+$/, '')
    .toLowerCase();
}

/** 从任意文本中提取第一个 DOI 并归一化；找不到返回 undefined。 */
export function extractDoi(value: string): string | undefined {
  const match = value.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? normalizeDoi(match[0]) : undefined;
}

/** 标题折叠：NFKD 分解、去变音符、小写、非字母数字折叠为单空格。用于跨源标题比较。 */
export function foldForMatch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 两个标题是否指向同一篇：折叠后相等，或一方包含另一方（副标题/截断差异）。 */
export function titlesAlign(left: string, right: string): boolean {
  const a = foldForMatch(left);
  const b = foldForMatch(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

/**
 * 保序去重：DOI 优先，无 DOI 时退回 "折叠标题:年份"。
 * 不同年份的同名条目不合并（同年再版极罕见，误合并代价更高）。
 */
export function dedupeWorks(items: WorkItem[]): WorkItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.doi || `${foldForMatch(item.title)}:${item.year ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
