/**
 * WorkItem → Zotero 归档编排：DOI 查重 → 建条目 → 挂 PDF → 收藏夹 → 笔记。
 * 幂等：同一 DOI 重复执行返回 'exists'；条目在但缺 PDF 时补挂返回 'attached'。
 */

import type { WorkItem, ZoteroSaveRequest, ZoteroSaveResult } from '../types.js';
import { ZoteroClient } from './client.js';

/** "First Middle Last" → { firstName: 'First Middle', lastName: 'Last' }；单名 → { name }。 */
export function splitAuthorName(fullName: string): { firstName?: string; lastName?: string; name?: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { name: parts[0]! };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1]! };
}

/** WorkItem → Zotero itemType：有 arXiv id 按 preprint，否则 journalArticle。 */
export function itemTypeFor(work: WorkItem): string {
  return work.externalIds.arxiv ? 'preprint' : 'journalArticle';
}

/** WorkItem → Zotero 字段集。 */
export function workToZoteroFields(work: WorkItem): Record<string, unknown> {
  const fields: Record<string, unknown> = { title: work.title };
  if (work.year) fields.date = String(work.year);
  if (work.venue) {
    if (work.externalIds.arxiv) fields.repository = work.venue || 'arXiv';
    else fields.publicationTitle = work.venue;
  }
  if (work.doi) fields.DOI = work.doi;
  if (work.url) fields.url = work.url;
  if (work.abstract) fields.abstractNote = work.abstract;
  const extra: string[] = [];
  if (work.citationCount !== null) extra.push(`Citations (${work.source}): ${work.citationCount}`);
  if (work.externalIds.openalex) extra.push(`OpenAlex: ${work.externalIds.openalex}`);
  if (extra.length) fields.extra = extra.join('\n');
  return fields;
}

export interface SaveWorkOptions {
  libraryKey?: string;
}

/**
 * 归档一篇文献到 Zotero：
 * 1. DOI 查重命中 → 有 pdfPath 时尝试补挂附件，返回 'exists' 或 'attached'
 * 2. 未命中 → 建条目（含收藏夹）→ 有 pdfPath 则上传附件 → 有 note 则建子笔记，返回 'created'
 */
export async function saveWork(
  client: ZoteroClient,
  request: ZoteroSaveRequest,
  options: SaveWorkOptions = {},
): Promise<ZoteroSaveResult> {
  const { item, pdfPath, collectionKey, note } = request;

  // 1. DOI 查重
  if (item.doi) {
    const existing = await client.findByDoi(item.doi, { ...(options.libraryKey ? { libraryKey: options.libraryKey } : {}) });
    if (existing) {
      if (pdfPath) {
        const attachment = await client.uploadPdfAttachment(pdfPath, existing.key, {
          title: item.title,
          ...(options.libraryKey ? { libraryKey: options.libraryKey } : {}),
        });
        return { outcome: attachment.duplicate ? 'exists' : 'attached', itemKey: existing.key, attachmentKey: attachment.attachmentKey };
      }
      return { outcome: 'exists', itemKey: existing.key };
    }
  }

  // 2. 建条目
  const { itemKey } = await client.createItem({
    itemType: itemTypeFor(item),
    fields: workToZoteroFields(item),
    creators: item.authors.map(splitAuthorName),
    ...(collectionKey ? { collectionKey } : {}),
    ...(options.libraryKey ? { libraryKey: options.libraryKey } : {}),
  });

  // 3. 附件
  let attachmentKey: string | undefined;
  if (pdfPath) {
    const attachment = await client.uploadPdfAttachment(pdfPath, itemKey, {
      title: item.title,
      ...(options.libraryKey ? { libraryKey: options.libraryKey } : {}),
    });
    attachmentKey = attachment.attachmentKey;
  }

  // 4. 笔记
  if (note) {
    await client.createNote(itemKey, note, { ...(options.libraryKey ? { libraryKey: options.libraryKey } : {}) });
  }

  return { outcome: 'created', itemKey, ...(attachmentKey ? { attachmentKey } : {}) };
}
