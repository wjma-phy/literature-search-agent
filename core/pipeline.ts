/**
 * 检索管线（深 module）：所有「拉一页 → 映射 → 去重 → 截断 → 诊断」的检索类 provider 共用。
 *
 * provider 交出三样东西就够：原始条目怎么取（rawsOf）、原始 JSON 怎么映射（mapItem）、
 * 一页怎么拉（fetch，URL/认证/节流各源自封）。管线负责 dedupeWorks、slice 与
 * diagnostics 的成败两态——修一处语义，四个 provider 一起生效。
 */

import { dedupeWorks } from './dedupe.js';
import type { SearchResult, WorkItem } from './types.js';

/** 结果上限钳制（各源有各自的硬上限）。 */
export function clampLimit(limit: number | undefined, fallback: number, max = 200): number {
  return Math.min(Math.max(limit ?? fallback, 1), max);
}

export function okDiagnostics(source: string, count: number): SearchResult['diagnostics'] {
  return { [source]: { ok: true, count } };
}

export function errorDiagnostics(source: string, error: unknown): SearchResult['diagnostics'] {
  return {
    [source]: { ok: false, count: 0, error: error instanceof Error ? error.message : String(error) },
  };
}

export interface SearchPipelineSpec<TRaw> {
  /** 数据源名（写进 diagnostics 的键） */
  source: string;
  /** 去重并截断后的结果上限 */
  limit: number;
  /** 从响应值中取原始条目数组 */
  rawsOf: (value: unknown) => readonly TRaw[];
  /** 原始 JSON → 统一文献条目；无标题的返回 undefined 丢弃 */
  mapItem: (raw: TRaw) => WorkItem | undefined;
  /** 拉取一页（URL / 认证 / 节流已在此封装） */
  fetch: () => Promise<unknown>;
}

/** provider 失败时返回空结果 + diagnostics，不向上抛（调用方按空结果处理）。 */
export async function runSearchPipeline<TRaw>(spec: SearchPipelineSpec<TRaw>): Promise<SearchResult> {
  try {
    const value = await spec.fetch();
    const items = dedupeWorks(
      spec.rawsOf(value).flatMap((raw) => {
        const item = spec.mapItem(raw);
        return item ? [item] : [];
      }),
    ).slice(0, spec.limit);
    return { items, diagnostics: okDiagnostics(spec.source, items.length) };
  } catch (error) {
    return { items: [], diagnostics: errorDiagnostics(spec.source, error) };
  }
}