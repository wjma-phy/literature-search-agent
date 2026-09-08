#!/usr/bin/env node
/**
 * lit-search CLI：核心库的调试与手动使用入口。
 * 子命令：
 *   search <query> [--limit N] [--from YYYY] [--to YYYY] [--pretty]
 *   lookup <doi> [--pretty]
 *   cited-by <doi|openalex-id> [--limit N] [--pretty]
 * 认证从环境变量注入：LIT_SEARCH_OPENALEX_API_KEY / LIT_SEARCH_MAILTO。
 */

import { parseArgs } from 'node:util';
import { citedByOpenAlex, lookupOpenAlexByDoi, searchOpenAlex } from '../../core/index.js';
import type { OpenAlexAuth } from '../../core/index.js';

function authFromEnv(): OpenAlexAuth {
  const auth: OpenAlexAuth = {};
  const apiKey = process.env.LIT_SEARCH_OPENALEX_API_KEY?.trim();
  const mailto = process.env.LIT_SEARCH_MAILTO?.trim();
  if (apiKey) auth.apiKey = apiKey;
  if (mailto) auth.mailto = mailto;
  if (!apiKey && !mailto) {
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
      '  lit-search search <query> [--limit N] [--from YYYY] [--to YYYY] [--pretty]',
      '  lit-search lookup <doi> [--pretty]',
      '  lit-search cited-by <doi|openalex-id> [--limit N] [--pretty]',
      '',
      '环境变量：LIT_SEARCH_OPENALEX_API_KEY、LIT_SEARCH_MAILTO',
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const auth = authFromEnv();

  if (command === 'search') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        limit: { type: 'string', default: '10' },
        from: { type: 'string' },
        to: { type: 'string' },
        pretty: { type: 'boolean', default: false },
      },
    });
    const query = positionals.join(' ').trim();
    if (!query) usage();
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) fail(`--limit 需要正整数，收到 "${values.limit}"。`, 2);
    const yearFrom = parseYear(values.from, 'from');
    const yearTo = parseYear(values.to, 'to');
    const result = await searchOpenAlex(query, {
      limit,
      ...auth,
      ...(yearFrom !== undefined ? { yearFrom } : {}),
      ...(yearTo !== undefined ? { yearTo } : {}),
    });
    printJson(result, values.pretty);
    if (!result.diagnostics.openalex?.ok) process.exitCode = 1;
    return;
  }

  if (command === 'lookup') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { pretty: { type: 'boolean', default: false } },
    });
    const doi = positionals[0];
    if (!doi) usage();
    const item = await lookupOpenAlexByDoi(doi, auth);
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
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) fail(`--limit 需要正整数，收到 "${values.limit}"。`, 2);
    const result = await citedByOpenAlex(id, { limit, ...auth });
    printJson(result, values.pretty);
    if (!result.diagnostics.openalex?.ok) process.exitCode = 1;
    return;
  }

  usage();
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
