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

import { parseArgs } from 'node:util';
import {
  citedByOpenAlex,
  discoverOaPdfUrl,
  downloadPdf,
  enrichAbstract,
  extractPdfText,
  lookupCrossrefByDoi,
  lookupOpenAlexByDoi,
  lookupS2ByDoi,
  searchCrossref,
  searchOpenAlex,
  searchSemanticScholar,
} from '../../core/index.js';
import type { SearchResult, WorkItem } from '../../core/index.js';

interface CliAuth {
  openAlexApiKey?: string;
  s2ApiKey?: string;
  mailto?: string;
}

function authFromEnv(): CliAuth {
  const auth: CliAuth = {};
  const openAlexApiKey = process.env.LIT_SEARCH_OPENALEX_API_KEY?.trim();
  const s2ApiKey = process.env.LIT_SEARCH_S2_API_KEY?.trim();
  const mailto = process.env.LIT_SEARCH_MAILTO?.trim();
  if (openAlexApiKey) auth.openAlexApiKey = openAlexApiKey;
  if (s2ApiKey) auth.s2ApiKey = s2ApiKey;
  if (mailto) auth.mailto = mailto;
  if (!openAlexApiKey && !mailto) {
    process.stderr.write(
      '[lit-search] 提示：未配置 LIT_SEARCH_OPENALEX_API_KEY / LIT_SEARCH_MAILTO，使用 OpenAlex 匿名池（较慢）。\n',
    );
  }
  return auth;
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
      '',
      '环境变量：LIT_SEARCH_OPENALEX_API_KEY、LIT_SEARCH_S2_API_KEY、LIT_SEARCH_MAILTO',
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

async function searchBySource(source: string, query: string, auth: CliAuth, opts: {
  limit: number;
  yearFrom?: number;
  yearTo?: number;
}): Promise<SearchResult> {
  if (source === 'openalex') {
    return searchOpenAlex(query, {
      ...opts,
      ...(auth.openAlexApiKey ? { apiKey: auth.openAlexApiKey } : {}),
      ...(auth.mailto ? { mailto: auth.mailto } : {}),
    });
  }
  if (source === 's2') {
    return searchSemanticScholar(query, { ...opts, ...(auth.s2ApiKey ? { apiKey: auth.s2ApiKey } : {}) });
  }
  if (source === 'crossref') {
    return searchCrossref(query, { ...opts, ...(auth.mailto ? { mailto: auth.mailto } : {}) });
  }
  return fail(`未知数据源 "${source}"（可选 openalex|s2|crossref）。`, 2);
}

async function lookupBySource(source: string, doi: string, auth: CliAuth): Promise<WorkItem | undefined> {
  if (source === 'openalex') {
    return lookupOpenAlexByDoi(doi, {
      ...(auth.openAlexApiKey ? { apiKey: auth.openAlexApiKey } : {}),
      ...(auth.mailto ? { mailto: auth.mailto } : {}),
    });
  }
  if (source === 's2') {
    return lookupS2ByDoi(doi, { ...(auth.s2ApiKey ? { apiKey: auth.s2ApiKey } : {}) });
  }
  if (source === 'crossref') {
    return lookupCrossrefByDoi(doi, { ...(auth.mailto ? { mailto: auth.mailto } : {}) });
  }
  return fail(`未知数据源 "${source}"（可选 openalex|s2|crossref）。`, 2);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const auth = authFromEnv();

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
    const result = await citedByOpenAlex(id, {
      limit,
      ...(auth.openAlexApiKey ? { apiKey: auth.openAlexApiKey } : {}),
      ...(auth.mailto ? { mailto: auth.mailto } : {}),
    });
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
      {
        ...(auth.openAlexApiKey ? { openAlexApiKey: auth.openAlexApiKey } : {}),
        ...(auth.s2ApiKey ? { s2ApiKey: auth.s2ApiKey } : {}),
        ...(auth.mailto ? { mailto: auth.mailto } : {}),
      },
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
    const url = await discoverOaPdfUrl(
      { doi, oaPdfUrl: '' },
      {
        ...(auth.openAlexApiKey ? { openAlexApiKey: auth.openAlexApiKey } : {}),
        ...(auth.mailto ? { mailto: auth.mailto } : {}),
      },
    );
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

  usage();
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
