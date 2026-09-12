/**
 * 展示投影（deep）：WorkItem → 各接口层对外输出的精简视图，预算策略只住这一处。
 *
 * preset 用默认（作者 ≤5、摘要 ≤2000）；插件面板用 includeAuthorsTotal + 不返回 abstract；
 * CLI 是调试出口，保留完整 WorkItem 不投影（去重/裁剪在工具侧）。
 */

import type { WorkItem } from './types.js';

export interface SearchViewOptions {
  /** 作者名单上限（默认 5） */
  maxAuthors?: number;
  /** 摘要字符上限（默认 2000；0 = 不裁剪） */
  maxAbstractChars?: number;
  /** 附上作者总数（插件面板用） */
  includeAuthorsTotal?: boolean;
  /** 是否输出摘要与状态（插件面板不需要，默认 true） */
  includeAbstract?: boolean;
}

export interface SearchView {
  title: string;
  authors: string[];
  authorsTotal?: number;
  year: number | null;
  venue: string;
  doi: string;
  url: string;
  citationCount: number | null;
  abstract?: string;
  abstractStatus?: WorkItem['abstractStatus'];
  oaPdfUrl: string;
  source: string;
}

export function toSearchView(item: WorkItem, options: SearchViewOptions = {}): SearchView {
  const maxAuthors = options.maxAuthors ?? 5;
  const maxAbstractChars = options.maxAbstractChars ?? 2000;
  const includeAbstract = options.includeAbstract ?? true;
  const view: SearchView = {
    title: item.title,
    authors: item.authors.slice(0, maxAuthors),
    year: item.year,
    venue: item.venue,
    doi: item.doi,
    url: item.url,
    citationCount: item.citationCount,
    oaPdfUrl: item.oaPdfUrl,
    source: item.source,
  };
  if (options.includeAuthorsTotal) view.authorsTotal = item.authors.length;
  if (includeAbstract) {
    view.abstract = maxAbstractChars > 0 ? item.abstract.slice(0, maxAbstractChars) : item.abstract;
    view.abstractStatus = item.abstractStatus;
  }
  return view;
}