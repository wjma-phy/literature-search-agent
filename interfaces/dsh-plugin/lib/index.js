/**
 * dsh-literature-search — Host 半。
 * 注册 /lit-search/api/search 路由，进程内直接调用 literature-search-agent core。
 *
 * 本地开发：经 pnpm file: 软链安装时，'../../dist/core/index.js' 解析到仓库构建产物
 * （需先运行 pnpm build / npm run build 生成 dist/）。
 * 发布形态：后续用 tsdown 把 core 打进本文件（或依赖已发布的 literature-search-agent 包）。
 *
 * 认证从环境变量注入：LIT_SEARCH_OPENALEX_API_KEY / LIT_SEARCH_MAILTO。
 */

import { searchOpenAlex } from '../../dist/core/index.js';

const ROUTE = '/lit-search/api/search';

function authFromEnv() {
  const auth = {};
  const apiKey = (process.env.LIT_SEARCH_OPENALEX_API_KEY || '').trim();
  const mailto = (process.env.LIT_SEARCH_MAILTO || '').trim();
  if (apiKey) auth.apiKey = apiKey;
  if (mailto) auth.mailto = mailto;
  return auth;
}

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 10;
  return Math.min(n, 25);
}

function trimItem(w) {
  return {
    title: String(w.title || ''),
    authors: Array.isArray(w.authors) ? w.authors.slice(0, 4) : [],
    authorsTotal: Array.isArray(w.authors) ? w.authors.length : 0,
    year: typeof w.year === 'number' ? w.year : null,
    venue: String(w.venue || ''),
    doi: String(w.doi || ''),
    url: String(w.url || ''),
    citationCount: typeof w.citationCount === 'number' ? w.citationCount : null,
    oaPdfUrl: String(w.oaPdfUrl || ''),
    source: String(w.source || ''),
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export default {
  name: 'literature-search',
  apply(ctx) {
    const webServer = ctx.get('webServer');
    if (webServer === undefined) {
      console.warn('[dsh-literature-search] webServer service unavailable; plugin idle');
      return;
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '', 'http://localhost');
          const query = (url.searchParams.get('q') || '').trim();
          if (!query) {
            sendJson(res, 400, { ok: false, error: 'missing query parameter q' });
            return;
          }
          const limit = clampLimit(url.searchParams.get('limit'));
          const yearFrom = url.searchParams.get('from');
          const yearTo = url.searchParams.get('to');
          const result = await searchOpenAlex(query, {
            limit,
            ...authFromEnv(),
            ...(yearFrom ? { yearFrom: Number(yearFrom) } : {}),
            ...(yearTo ? { yearTo: Number(yearTo) } : {}),
          });
          sendJson(res, 200, {
            ok: true,
            items: result.items.map(trimItem),
            diagnostics: result.diagnostics,
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      },
    }));
  },
};
