/**
 * OA PDF 链接发现：WorkItem.oaPdfUrl → OpenAlex → Unpaywall。
 */

import { normalizeDoi } from '../dedupe.js';
import { lookupOpenAlexByDoi } from '../providers/openalex.js';
import { lookupUnpaywall } from '../providers/unpaywall.js';

export interface DiscoverOptions {
  openAlexApiKey?: string;
  mailto?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * 为一篇文献找 OA PDF 直链。已有 oaPdfUrl 直接返回；
 * 否则查 OpenAlex best_oa_location，再查 Unpaywall（需要 mailto）。
 * 全部落空返回空串（调用方降级为"摘要可用、全文缺失"）。
 */
export async function discoverOaPdfUrl(
  work: { doi: string; oaPdfUrl: string },
  options: DiscoverOptions = {},
): Promise<string> {
  if (work.oaPdfUrl) return work.oaPdfUrl;
  const doi = normalizeDoi(work.doi);
  if (!doi) return '';

  const fetchOpts = {
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };

  const openalex = await lookupOpenAlexByDoi(doi, {
    ...(options.openAlexApiKey ? { apiKey: options.openAlexApiKey } : {}),
    ...(options.mailto ? { mailto: options.mailto } : {}),
    ...fetchOpts,
  }).catch(() => undefined);
  if (openalex?.oaPdfUrl) return openalex.oaPdfUrl;

  if (options.mailto) {
    const unpaywall = await lookupUnpaywall(doi, { email: options.mailto, ...fetchOpts }).catch(() => undefined);
    if (unpaywall?.bestPdfUrl) return unpaywall.bestPdfUrl;
    const anyPdf = unpaywall?.locations.find((l) => l.pdfUrl);
    if (anyPdf) return anyPdf.pdfUrl;
  }
  return '';
}
