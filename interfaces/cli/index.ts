#!/usr/bin/env node
/**
 * lit-search CLI：核心库的调试与手动使用入口。
 * 子命令：
 *   search <query> [--source openalex|s2|crossref] [--limit N] [--from YYYY] [--to YYYY] [--pretty]
 *   lookup <doi> [--source openalex|s2|crossref] [--pretty]
 *   cited-by <doi|openalex-id> [--limit N] [--pretty]
 *   abstract <doi|标题> [--pretty]           摘要富集链（多源兜底）
 *   pdf <doi> [--out path]                 OA PDF 发现 + 下载
 *   extract <pdf-path> [--max-pages N] [--max-chars N] [--pretty]
 * 认证从环境变量注入：LIT_SEARCH_OPENALEX_API_KEY / LIT_SEARCH_S2_API_KEY / LIT_SEARCH_MAILTO。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ZoteroClient,
  citedByOpenAlex,
  crossrefAuth,
  discoverOaPdfUrl,
  downloadPdf,
  enrichAbstract,
  enrichAuth,
  extractPdfText,
  lookupCrossrefByDoi,
  lookupOpenAlexByDoi,
  lookupS2ByDoi,
  openAlexAuth,
  parseEnvAuth,
  pdfAuth,
  s2Auth,
  saveWork,
  searchCrossref,
  searchOpenAlex,
  searchSemanticScholar,
  zoteroAuth,
} from '../../core/index.js';
import type { EnvAuth, SearchResult, WorkItem } from '../../core/index.js';

function warnMissingPolitePool(auth: EnvAuth): void {
  if (!auth.apiKey && !auth.mailto) {
    process.stderr.write(
      '[lit-search] 提示：未配置 LIT_SEARCH_OPENALEX_API_KEY / LIT_SEARCH_MAILTO，使用 OpenAlex 匿名池（较慢）。\n',
    );
  }
}

function zoteroClient(auth: EnvAuth): ZoteroClient {
  return new ZoteroClient({
    // CLI 是短生命周期进程；remember=false 的 key 跨进程失效，遇 401 直接弹窗重授权
    autoAuthorize: true,
    ...zoteroAuth(auth),
  });
}

function printJson(value: unknown, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`[lit-search] 错误：${message}\n`);
  process.exit(code);
}

function usage(): never {
  process.stderr.write(
    [
      '用法：',
      '  lit-search search <query> [--source openalex|s2|crossref] [--limit N] [--from YYYY] [--to YYYY] [--pretty]',
      '  lit-search lookup <doi> [--source openalex|s2|crossref] [--pretty]',
      '  lit-search cited-by <doi|openalex-id> [--limit N] [--pretty]',
      '  lit-search abstract <doi|标题> [--pretty]',
      '  lit-search pdf <doi> [--out path]',
      '  lit-search extract <pdf-path> [--max-pages N] [--max-chars N] [--pretty]',
      '  lit-search zotero-auth                                     弹出 Zotero 授权窗口，获取写 key',
      '  lit-search zotero-search <query> [--limit N] [--pretty]    检索本地 Zotero 库',
      '  lit-search zotero-save <doi> [--collection KEY] [--note "..."] [--no-pdf] [--pretty]',
      '',
      '环境变量：LIT_SEARCH_OPENALEX_API_KEY、LIT_SEARCH_S2_API_KEY、LIT_SEARCH_MAILTO、',
      '          LIT_SEARCH_ZOTERO_KEY（zotero-auth 获得）、LIT_SEARCH_ZOTERO_URL',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

function parseYear(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1000 || year > 3000) fail(`--${flag} 需要四位年份，收到 "${value}"。`, 2);
  return year;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`--${flag} 需要正整数，收到 "${value}"。`, 2);
  return n;
}

async function searchBySource(source: string, query: string, auth: EnvAuth, opts: {
  limit: number;
  yearFrom?: number;
  yearTo?: number;
}): Promise<SearchResult> {
  if (source === 'openalex') return searchOpenAlex(query, { ...opts, ...openAlexAuth(auth) });
  if (source === 's2') return searchSemanticScholar(query, { ...opts, ...s2Auth(auth) });
  if (source === 'crossref') return searchCrossref(query, { ...opts, ...crossrefAuth(auth) });
  return fail(`未知数据源 "${source}"（可选 openalex|s2|crossref）。`, 2);
}

async function lookupBySource(source: string, doi: string, auth: EnvAuth): Promise<WorkItem | undefined> {
  if (source === 'openalex') return lookupOpenAlexByDoi(doi, openAlexAuth(auth));
  if (source === 's2') return lookupS2ByDoi(doi, s2Auth(auth));
  if (source === 'crossref') return lookupCrossrefByDoi(doi, crossrefAuth(auth));
  return fail(`未知数据源 "${source}"（可选 openalex|s2|crossref）。`, 2);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const auth = parseEnvAuth(process.env);
  warnMissingPolitePool(auth);

  if (command === 'search') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        source: { type: 'string', default: 'openalex' },
        limit: { type: 'string', default: '10' },
        from: { type: 'string' },
        to: { type: 'string' },
        pretty: { type: 'boolean', default: false },
      },
    });
    const query = positionals.join(' ').trim();
    if (!query) usage();
    const limit = parsePositiveInt(values.limit, 'limit');
    const yearFrom = parseYear(values.from, 'from');
    const yearTo = parseYear(values.to, 'to');
    const result = await searchBySource(values.source, query, auth, {
      limit,
      ...(yearFrom !== undefined ? { yearFrom } : {}),
      ...(yearTo !== undefined ? { yearTo } : {}),
    });
    printJson(result, values.pretty);
    if (Object.values(result.diagnostics).some((d) => !d.ok)) process.exitCode = 1;
    return;
  }

  if (command === 'lookup') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        source: { type: 'string', default: 'openalex' },
        pretty: { type: 'boolean', default: false },
      },
    });
    const doi = positionals[0];
    if (!doi) usage();
    const item = await lookupBySource(values.source, doi, auth);
    if (!item) fail(`未找到 DOI "${doi}" 对应的文献。`, 1);
    printJson(item, values.pretty);
    return;
  }

  if (command === 'cited-by') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        limit: { type: 'string', default: '25' },
        pretty: { type: 'boolean', default: false },
      },
    });
    const id = positionals[0];
    if (!id) usage();
    const limit = parsePositiveInt(values.limit, 'limit');
    const result = await citedByOpenAlex(id, { limit, ...openAlexAuth(auth) });
    printJson(result, values.pretty);
    if (!result.diagnostics.openalex?.ok) process.exitCode = 1;
    return;
  }

  if (command === 'abstract') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { pretty: { type: 'boolean', default: false } },
    });
    const input = positionals.join(' ').trim();
    if (!input) usage();
    // 形如 DOI 的按 DOI 走，否则按标题走
    const isDoi = /^(?:https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\//i.test(input);
    const result = await enrichAbstract(
      isDoi ? { doi: input, title: '' } : { title: input },
      enrichAuth(auth),
    );
    printJson(result, values.pretty);
    if (result.status === 'missing') process.exitCode = 1;
    return;
  }

  if (command === 'pdf') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { out: { type: 'string' } },
    });
    const doi = positionals[0];
    if (!doi) usage();
    const url = await discoverOaPdfUrl({ doi, oaPdfUrl: '' }, pdfAuth(auth));
    if (!url) fail(`未找到 DOI "${doi}" 的 OA PDF（可能非开放获取）。`, 1);
    const dest = values.out ?? `./pdfs/${doi.replace(/[^\w.-]+/g, '_')}.pdf`;
    const result = await downloadPdf(url, dest);
    printJson(result, true);
    return;
  }

  if (command === 'extract') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        'max-pages': { type: 'string' },
        'max-chars': { type: 'string' },
        pretty: { type: 'boolean', default: false },
      },
    });
    const path = positionals[0];
    if (!path) usage();
    const result = await extractPdfText(path, {
      ...(values['max-pages'] !== undefined ? { maxPages: parsePositiveInt(values['max-pages'], 'max-pages') } : {}),
      ...(values['max-chars'] !== undefined ? { maxChars: parsePositiveInt(values['max-chars'], 'max-chars') } : {}),
    });
    printJson(result, values.pretty);
    return;
  }

  if (command === 'zotero-auth') {
    const client = zoteroClient(auth);
    const { zoteroVersion } = await client.ping();
    process.stderr.write(`[lit-search] Zotero ${zoteroVersion} 在线，请在 Zotero 弹窗中点击「始终允许 / Always Allow」…\n`);
    const { key, remember } = await client.authorize();
    process.stdout.write(`${key}\n`);
    if (remember) {
      process.stderr.write(
        `[lit-search] 获得持久 key。持久化：\n  setx LIT_SEARCH_ZOTERO_KEY "${key}"\n（对之后新开的终端生效）\n`,
      );
    } else {
      process.stderr.write(
        '[lit-search] 注意：这是单次 key（弹窗中需点「始终允许」才能获得持久 key），一个写请求后即失效。\n',
      );
    }
    return;
  }

  if (command === 'zotero-search') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        limit: { type: 'string', default: '20' },
        pretty: { type: 'boolean', default: false },
      },
    });
    const query = positionals.join(' ').trim();
    if (!query) usage();
    const limit = parsePositiveInt(values.limit, 'limit');
    const items = await zoteroClient(auth).searchItems(query, { limit });
    printJson({ items, count: items.length }, values.pretty);
    return;
  }

  if (command === 'zotero-save') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        collection: { type: 'string' },
        note: { type: 'string' },
        'no-pdf': { type: 'boolean', default: false },
        pretty: { type: 'boolean', default: false },
      },
    });
    const doi = positionals[0];
    if (!doi) usage();

    // 1. 取元数据（OpenAlex 为主，失败时富集链兜底摘要）
    let work = await lookupOpenAlexByDoi(doi, openAlexAuth(auth)).catch(() => undefined);
    if (!work) {
      const enriched = await enrichAbstract({ doi, title: '' }, enrichAuth(auth));
      if (!enriched.doi) fail(`无法解析 DOI "${doi}"。`, 1);
      work = {
        title: doi, authors: [], year: null, venue: '', doi: enriched.doi, url: '',
        citationCount: null, abstract: enriched.abstract, abstractStatus: enriched.status === 'complete' ? 'complete' : 'missing',
        oaPdfUrl: '', source: 'enrich', externalIds: {},
      };
    } else if (!work.abstract) {
      const enriched = await enrichAbstract({ doi: work.doi, title: work.title }, enrichAuth(auth));
      if (enriched.abstract) {
        work = { ...work, abstract: enriched.abstract, abstractStatus: 'complete' };
      }
    }

    // 2. OA PDF（--no-pdf 跳过）
    let pdfPath: string | undefined;
    let tmpDir: string | undefined;
    if (!values['no-pdf']) {
      const url = work.oaPdfUrl || await discoverOaPdfUrl(work, pdfAuth(auth));
      if (url) {
        tmpDir = await mkdtemp(join(tmpdir(), 'lit-search-zotero-'));
        try {
          pdfPath = (await downloadPdf(url, join(tmpDir, 'paper.pdf'))).path;
        } catch (error) {
          process.stderr.write(`[lit-search] PDF 下载失败（${error instanceof Error ? error.message : String(error)}），仅保存元数据。\n`);
        }
      } else {
        process.stderr.write('[lit-search] 未找到 OA PDF，仅保存元数据。\n');
      }
    }

    // 3. 归档（DOI 查重 + 建条目 + 附件 + 笔记 + 收藏夹）
    try {
      const result = await saveWork(zoteroClient(auth), {
        item: work,
        ...(pdfPath ? { pdfPath } : {}),
        ...(values.collection ? { collectionKey: values.collection } : {}),
        ...(values.note ? { note: values.note } : {}),
      });
      printJson({ ...result, title: work.title, doi: work.doi }, values.pretty);
    } finally {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    }
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
