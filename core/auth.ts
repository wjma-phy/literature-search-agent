/**
 * 环境变量认证的统一解析与按源装配。
 *
 * 纯函数：不读 process.env，由接口层（CLI / preset / 插件）传入 env 记录解析一次，
 * 再用各源装配函数把 EnvAuth 折叠成对应 provider 认得的选项对象——
 * 「每个数据源认哪些键」的知识只住在这一处。
 */

export interface EnvAuth {
  /** LIT_SEARCH_OPENALEX_API_KEY */
  apiKey?: string;
  /** LIT_SEARCH_MAILTO（OpenAlex polite pool / Crossref / Unpaywall 共用） */
  mailto?: string;
  /** LIT_SEARCH_S2_API_KEY */
  s2Key?: string;
  /** LIT_SEARCH_ZOTERO_KEY */
  zoteroKey?: string;
  /** LIT_SEARCH_ZOTERO_URL */
  zoteroUrl?: string;
  /** LIT_SEARCH_CORE_URL */
  coreUrl?: string;
}

function pick(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function parseEnvAuth(env: Record<string, string | undefined>): EnvAuth {
  const apiKey = pick(env, 'LIT_SEARCH_OPENALEX_API_KEY');
  const mailto = pick(env, 'LIT_SEARCH_MAILTO');
  const s2Key = pick(env, 'LIT_SEARCH_S2_API_KEY');
  const zoteroKey = pick(env, 'LIT_SEARCH_ZOTERO_KEY');
  const zoteroUrl = pick(env, 'LIT_SEARCH_ZOTERO_URL');
  const coreUrl = pick(env, 'LIT_SEARCH_CORE_URL');
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(mailto ? { mailto } : {}),
    ...(s2Key ? { s2Key } : {}),
    ...(zoteroKey ? { zoteroKey } : {}),
    ...(zoteroUrl ? { zoteroUrl } : {}),
    ...(coreUrl ? { coreUrl } : {}),
  };
}

/** OpenAlex 认 apiKey / mailto。 */
export function openAlexAuth(auth: EnvAuth): { apiKey?: string; mailto?: string } {
  return {
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    ...(auth.mailto ? { mailto: auth.mailto } : {}),
  };
}

/** Semantic Scholar 认 x-api-key（选项键名 apiKey）。 */
export function s2Auth(auth: EnvAuth): { apiKey?: string } {
  return auth.s2Key ? { apiKey: auth.s2Key } : {};
}

/** Crossref 认 mailto。 */
export function crossrefAuth(auth: EnvAuth): { mailto?: string } {
  return auth.mailto ? { mailto: auth.mailto } : {};
}

/** Unpaywall 认 email（必填）。 */
export function unpaywallAuth(auth: EnvAuth): { email?: string } {
  return auth.mailto ? { email: auth.mailto } : {};
}

/** 摘要富集链（enrichAbstract）认 openAlexApiKey / s2ApiKey / mailto。 */
export function enrichAuth(auth: EnvAuth): { openAlexApiKey?: string; s2ApiKey?: string; mailto?: string } {
  return {
    ...(auth.apiKey ? { openAlexApiKey: auth.apiKey } : {}),
    ...(auth.s2Key ? { s2ApiKey: auth.s2Key } : {}),
    ...(auth.mailto ? { mailto: auth.mailto } : {}),
  };
}

/** OA PDF 发现（discoverOaPdfUrl）认 openAlexApiKey / mailto。 */
export function pdfAuth(auth: EnvAuth): { openAlexApiKey?: string; mailto?: string } {
  return {
    ...(auth.apiKey ? { openAlexApiKey: auth.apiKey } : {}),
    ...(auth.mailto ? { mailto: auth.mailto } : {}),
  };
}

/** Zotero 客户端认 apiKey / baseUrl。 */
export function zoteroAuth(auth: EnvAuth): { apiKey?: string; baseUrl?: string } {
  return {
    ...(auth.zoteroKey ? { apiKey: auth.zoteroKey } : {}),
    ...(auth.zoteroUrl ? { baseUrl: auth.zoteroUrl } : {}),
  };
}