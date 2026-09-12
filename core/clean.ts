/**
 * HTML/JATS 标记清洗：单一实现，所有摘要源共用（此前 html/sources/crossref 各克隆一份）。
 *
 * 两个可选项在旧实现里是行为差异，这里收窄成参数：
 * - nbsp：是否折叠 &nbsp;（HTML 源默认 yes，Crossref 默认 no）
 * - extraEntities：是否追加 &quot; / &#39;（Crossref 用）
 *
 * 注意替换顺序（先 &amp; 后 &lt;/&gt;）是刻意的：双编码的 "&amp;lt;" 应先解码出 "&lt;" 再解成 "<"。
 */

export interface CleanMarkupOptions {
  nbsp?: boolean;
  extraEntities?: boolean;
}

export function cleanMarkup(value: string | undefined, options: CleanMarkupOptions = {}): string {
  if (!value) return '';
  const nbsp = options.nbsp ?? true;
  const extraEntities = options.extraEntities ?? false;
  let out = value.replace(/<[^>]+>/g, ' ');
  if (nbsp) out = out.replace(/&nbsp;/gi, ' ');
  out = out.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  if (extraEntities) out = out.replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  return out.replace(/\s+/g, ' ').trim();
}