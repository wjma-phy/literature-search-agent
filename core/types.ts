/**
 * 核心领域类型：一篇文献在所有数据源间的统一表示。
 * 设计原则：只保留 Agent 调研真正需要的字段；各 provider 的原始响应在映射层消费，不外泄。
 */

/** 统一文献条目（检索结果 / 富集结果 / Zotero 归档共用） */
export interface WorkItem {
  /** 标题（必填；无标题的检索结果直接丢弃） */
  title: string;
  /** 作者列表（姓在前，最多 30 人） */
  authors: string[];
  /** 发表年份 */
  year: number | null;
  /** 期刊 / 会议 / 预印本平台名 */
  venue: string;
  /** 归一化 DOI（小写、去 https://doi.org/ 前缀；无则空串） */
  doi: string;
  /** 来源页面 URL */
  url: string;
  /** 被引次数（来源不可知时为 null） */
  citationCount: number | null;
  /** 摘要（未富集时为空串；用 abstractStatus 区分"没跑"和"没有"） */
  abstract: string;
  abstractStatus: 'pending' | 'complete' | 'missing';
  /** 开放获取 PDF 直链（Unpaywall / OpenAlex OA 位置；无则空串） */
  oaPdfUrl: string;
  /** 产生该条目的数据源（openalex / semanticscholar / crossref / …） */
  source: string;
  /** 外部 ID 集合（openalex work id、S2 paperId、arxiv id 等，供图谱与富集回查） */
  externalIds: Record<string, string>;
}

/** 检索选项（各 provider 自行忽略不支持的字段） */
export interface SearchOptions {
  /** 结果上限（各 provider 内部再 clamp 到自己的上限） */
  limit?: number;
  /** 年份范围（含端点） */
  yearFrom?: number;
  yearTo?: number;
  signal?: AbortSignal;
}

/** 检索结果：条目 + 来源诊断（哪个源成功/失败、命中数） */
export interface SearchResult {
  items: WorkItem[];
  /** 每源诊断：provider → { ok, count, error? } */
  diagnostics: Record<string, { ok: boolean; count: number; error?: string }>;
}

/** Zotero 归档请求（zotero_save 的输入） */
export interface ZoteroSaveRequest {
  item: WorkItem;
  /** 已下载到本地的 PDF 路径（可选；有则走附件上传） */
  pdfPath?: string;
  /** 目标收藏夹 key（可选） */
  collectionKey?: string;
  /** AI 生成的关联笔记（可选，存为子笔记条目） */
  note?: string;
}

export interface ZoteroSaveResult {
  /** 'created' 新建 | 'attached' 已有条目上附加了 PDF | 'exists' 已存在未动 */
  outcome: 'created' | 'attached' | 'exists';
  itemKey: string;
  attachmentKey?: string;
}
