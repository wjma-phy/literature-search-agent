/**
 * dsh-literature-search — Host 半。
 * 注册 /lit-search/api/search 路由，进程内直接调用 literature-search-agent core。
 *
 * core 以自包含 bundle 形式随包分发（lib/vendor/lit-core.bundle.js，由仓库构建脚本生成），
 * 因此本包安装后无需 literature-search-agent 源码或 dist/ 目录。
 * pdf-parse 为可选运行时依赖，仅在 PDF 全文提取时惰性加载。
 *
 * 认证从环境变量注入：LIT_SEARCH_OPENALEX_API_KEY / LIT_SEARCH_MAILTO（统一解析在 core/auth）。
 */

import { openAlexAuth, parseEnvAuth, searchOpenAlex, toSearchView } from './vendor/lit-core.bundle.js';

const ROUTE = '/lit-search/api/search';

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 10;
  return Math.min(n, 25);
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
            ...openAlexAuth(parseEnvAuth(process.env)),
            ...(yearFrom ? { yearFrom: Number(yearFrom) } : {}),
            ...(yearTo ? { yearTo: Number(yearTo) } : {}),
          });
          sendJson(res, 200, {
            ok: true,
            items: result.items.map((w) => toSearchView(w, { maxAuthors: 4, includeAuthorsTotal: true, includeAbstract: false })),
            diagnostics: result.diagnostics,
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      },
    }));
  },
};
