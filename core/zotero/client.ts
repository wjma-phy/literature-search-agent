/**
 * Zotero 本地 API 客户端（localhost:23119）。
 * 移植自 Read-Studio server/lib/zoteroApi.js，裁剪为本项目需要的子集：
 * 读取免认证；写入（Zotero 10+）需 Zotero-Server-ID + Zotero-API-Key
 * （key 由 authorize() 弹窗授权获得，调用方负责持久化复用）。
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { record } from '../json.js';
import { normalizeDoi } from '../dedupe.js';

const DEFAULT_BASE_URL = 'http://localhost:23119/api';
export const MIN_WRITE_MAJOR_VERSION = 10;

export type ZoteroErrorCode = 'offline' | 'api-disabled' | 'needs-auth' | 'denied' | 'conflict' | 'version' | 'http';

export class ZoteroApiError extends Error {
  constructor(
    message: string,
    readonly code: ZoteroErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ZoteroApiError';
  }
}

export interface ZoteroItemSummary {
  key: string;
  libraryKey: string;
  itemType: string;
  title: string;
  authors: string[];
  year: number | null;
  doi: string;
  url: string;
}

export interface ZoteroClientOptions {
  baseUrl?: string;
  /** 已授权的写 key（zotero-auth 获得）；只读操作不需要 */
  apiKey?: string;
  /**
   * true 时写请求遇 401 自动弹窗授权一次并重试（同进程内使用新 key）。
   * Zotero remember=false 的 key 跨进程即失效，CLI 等短生命周期进程应开启。
   */
  autoAuthorize?: boolean;
  /** 授权弹窗里显示的应用名 */
  appName?: string;
  fetchImpl?: typeof fetch;
}

function extractYear(dateStr: unknown): number | null {
  const match = String(dateStr ?? '').match(/(19|20)\d{2}/);
  return match ? parseInt(match[0], 10) : null;
}

function creatorsToAuthors(creators: unknown): string[] {
  if (!Array.isArray(creators)) return [];
  return creators.flatMap((c) => {
    const creator = record(c);
    if (typeof creator.name === 'string' && creator.name) return [creator.name];
    const name = [creator.firstName, creator.lastName].filter((p): p is string => typeof p === 'string' && Boolean(p)).join(' ');
    return name ? [name] : [];
  });
}

export class ZoteroClient {
  private readonly baseUrl: string;
  private apiKey?: string;
  private readonly autoAuthorize: boolean;
  private readonly appName: string;
  private readonly fetchImpl: typeof fetch;
  private serverId: string | null = null;
  /** Zotero 版本号（从响应头学习） */
  zoteroVersion = '';

  constructor(options: ZoteroClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (options.apiKey?.trim()) this.apiKey = options.apiKey.trim();
    this.autoAuthorize = options.autoAuthorize ?? false;
    this.appName = options.appName ?? 'literature-search-agent';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private recordHeaders(res: Response): void {
    const sid = res.headers.get('Zotero-Server-ID');
    if (sid) this.serverId = sid;
    const ver = res.headers.get('X-Zotero-Version');
    if (ver) this.zoteroVersion = ver;
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: string | Uint8Array | object; headers?: Record<string, string>; raw?: boolean; write?: boolean; retryAuth?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    // Zotero 内嵌服务器是 HTTP/1.0 且 keep-alive 支持不稳定；禁用连接复用防止 undici 复用已关闭 socket（"fetch failed"）
    headers['Connection'] = 'close';
    let body: string | Uint8Array | undefined;
    if (opts.body !== undefined) {
      if (typeof opts.body === 'string' || opts.body instanceof Uint8Array) {
        body = opts.body;
      } else {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        body = JSON.stringify(opts.body);
      }
    }
    if (opts.write) {
      if (!this.serverId) await this.ping();
      if (!this.serverId) throw new ZoteroApiError('无法获取 Zotero Server-ID。', 'offline');
      headers['Zotero-Server-ID'] = this.serverId;
      if (this.apiKey) headers['Zotero-API-Key'] = this.apiKey;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch {
      throw new ZoteroApiError(
        `无法连接 Zotero 本地 API（${this.baseUrl}）。请确认 Zotero 正在运行，且已开启「设置 → 高级 → 允许其他应用程序与此计算机上的 Zotero 通信」。`,
        'offline',
      );
    }
    this.recordHeaders(res);

    if (res.status === 403) throw new ZoteroApiError('Zotero 拒绝了请求（403），请在授权弹窗中点击允许。', 'api-disabled', 403);
    if (res.status === 401 && opts.write) {
      // key 失效/被消耗（remember=false 的 key 跨进程即失效）：同进程重授权一次后重试
      if (this.autoAuthorize && opts.retryAuth !== false) {
        await this.authorize(this.appName);
        return this.request(method, path, { ...opts, retryAuth: false });
      }
      throw new ZoteroApiError('写请求未授权（401），请先运行 zotero-auth 获取 key。', 'needs-auth', 401);
    }
    if (res.status === 412) throw new ZoteroApiError('数据已被其他操作修改（版本冲突 412），请重试。', 'conflict', 412);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new ZoteroApiError(`Zotero API HTTP ${res.status}: ${detail.slice(0, 200)}`, 'http', res.status);
    }
    if (opts.raw) return res;
    if (res.status === 204) return null;
    return res.json();
  }

  private get(path: string) { return this.request('GET', path); }
  private post(path: string, body: object | string, opts?: { write?: boolean; headers?: Record<string, string>; raw?: boolean }) {
    return this.request('POST', path, { ...opts, body });
  }
  private patch(path: string, body: object, opts?: { write?: boolean; headers?: Record<string, string> }) {
    return this.request('PATCH', path, { ...opts, body });
  }

  // ---------------------------------------------------------------------------
  // 状态与授权
  // ---------------------------------------------------------------------------

  /** 探测连接；同时从响应头学习 Server-ID 与版本。 */
  async ping(): Promise<{ serverId: string | null; zoteroVersion: string }> {
    const res = (await this.request('GET', '/', { raw: true })) as Response;
    await res.text();
    return { serverId: this.serverId, zoteroVersion: this.zoteroVersion };
  }

  /** 写入能力（Zotero 10+ 才支持本地 API 写入）。 */
  async canWrite(): Promise<boolean> {
    await this.ping();
    const major = parseInt(this.zoteroVersion.split('.')[0] ?? '0', 10);
    return major >= MIN_WRITE_MAJOR_VERSION;
  }

  /**
   * 弹窗请求用户授权写入。remember=true（用户选「始终允许」）时 Zotero 持久化该 key，
   * 可跨进程复用；remember=false 为单次 key，一个写请求后即被消耗。
   */
  async authorize(appName = 'literature-search-agent'): Promise<{ key: string; remember: boolean }> {
    if (!this.serverId) await this.ping();
    const doFetch = () => this.fetchImpl(`${this.baseUrl}/local/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Connection: 'close', // 防止 undici 复用 Zotero HTTP/1.0 已关闭的 socket
        ...(this.serverId ? { 'Zotero-Server-ID': this.serverId } : {}),
      },
      body: JSON.stringify({ appName }),
    });
    // 连接层偶发失败（HTTP/1.0 服务器连接管理脆弱）：重试一次
    const res = await doFetch().catch(() => doFetch()).catch((error: unknown) => {
      throw new ZoteroApiError(`无法连接 Zotero 进行授权（${error instanceof Error ? error.message : String(error)}）`, 'offline');
    });
    this.recordHeaders(res);
    if (res.status === 403) throw new ZoteroApiError('用户拒绝了写入授权。', 'denied', 403);
    if (!res.ok) throw new ZoteroApiError(`授权失败（HTTP ${res.status}）。写入需要 Zotero ${MIN_WRITE_MAJOR_VERSION}+。`, 'version', res.status);
    const data = record(await res.json());
    if (typeof data.key !== 'string' || !data.key) throw new ZoteroApiError('授权响应缺少 key。', 'http');
    this.apiKey = data.key; // 同进程立即生效（remember=false 的 key 跨进程失效）
    return { key: data.key, remember: data.remember === true };
  }

  // ---------------------------------------------------------------------------
  // 读取
  // ---------------------------------------------------------------------------

  /**
   * 关键词检索（本地 quicksearch，排除附件/笔记/批注）。读免认证。
   * qmode 默认 titleCreatorYear；查 DOI 等全字段需 'everything'。
   */
  async searchItems(query: string, options: { limit?: number; libraryKey?: string; qmode?: 'titleCreatorYear' | 'everything' } = {}): Promise<ZoteroItemSummary[]> {
    const limit = options.limit ?? 20;
    const prefix = libraryPrefix(options.libraryKey);
    const qmode = options.qmode ? `&qmode=${options.qmode}` : '';
    const value = await this.get(`${prefix}/items?q=${encodeURIComponent(query)}${qmode}&itemType=-attachment%20%7C%7C%20note%20%7C%7C%20annotation&limit=${limit}`);
    return (Array.isArray(value) ? value : []).map((entry) => {
      const item = record(entry);
      const data = record(item.data);
      return {
        key: typeof item.key === 'string' ? item.key : '',
        libraryKey: options.libraryKey ?? 'user',
        itemType: typeof data.itemType === 'string' ? data.itemType : '',
        title: typeof data.title === 'string' ? data.title : '',
        authors: creatorsToAuthors(data.creators),
        year: extractYear(data.date),
        doi: typeof data.DOI === 'string' ? normalizeDoi(data.DOI) : '',
        url: typeof data.url === 'string' ? data.url : '',
      };
    }).filter((item) => item.key);
  }

  /** DOI 查重：全字段 quicksearch（qmode=everything，默认 titleCreatorYear 不含 DOI）后按归一化 DOI 精确匹配。 */
  async findByDoi(doi: string, options: { libraryKey?: string } = {}): Promise<ZoteroItemSummary | undefined> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return undefined;
    const candidates = await this.searchItems(normalized, { limit: 25, qmode: 'everything', ...(options.libraryKey ? { libraryKey: options.libraryKey } : {}) });
    return candidates.find((item) => item.doi === normalized);
  }

  // ---------------------------------------------------------------------------
  // 写入（Zotero 10+，需授权 key）
  // ---------------------------------------------------------------------------

  /** 创建条目，返回新条目 key。 */
  async createItem(options: {
    itemType?: string;
    fields?: Record<string, unknown>;
    creators?: Array<{ firstName?: string; lastName?: string; name?: string }>;
    collectionKey?: string;
    libraryKey?: string;
  }): Promise<{ itemKey: string }> {
    const data: Record<string, unknown> = {
      itemType: options.itemType ?? 'journalArticle',
      ...options.fields,
      creators: (options.creators ?? []).map((c) => ({ creatorType: 'author', ...c })),
      tags: [],
      collections: options.collectionKey ? [options.collectionKey] : [],
    };
    const res = record(await this.post(`${libraryPrefix(options.libraryKey)}/items`, [data], { write: true }));
    const successful = record(res.successful);
    const first = record(successful['0']);
    if (typeof first.key !== 'string' || !first.key) {
      const failed = record(record(res.failed)['0']);
      throw new ZoteroApiError(`创建条目失败: ${typeof failed.message === 'string' ? failed.message : JSON.stringify(res).slice(0, 200)}`, 'http');
    }
    return { itemKey: first.key };
  }

  /** 在条目下创建子笔记。 */
  async createNote(parentItemKey: string, content: string, options: { libraryKey?: string } = {}): Promise<{ noteKey: string }> {
    const res = record(await this.post(`${libraryPrefix(options.libraryKey)}/items`, [{
      itemType: 'note',
      parentItem: parentItemKey,
      note: content,
      tags: [],
    }], { write: true }));
    const key = record(record(res.successful)['0']).key;
    if (typeof key !== 'string' || !key) throw new ZoteroApiError('创建笔记失败。', 'http');
    return { noteKey: key };
  }

  /** 加入收藏夹（读当前 collections 取并集，If-Unmodified-Since-Version 乐观锁）。 */
  async addToCollection(itemKey: string, collectionKey: string, options: { libraryKey?: string } = {}): Promise<void> {
    const prefix = libraryPrefix(options.libraryKey);
    const current = record(await this.get(`${prefix}/items/${encodeURIComponent(itemKey)}`));
    const data = record(current.data);
    const existing = new Set(Array.isArray(data.collections) ? data.collections : []);
    existing.add(collectionKey);
    await this.patch(`${prefix}/items/${encodeURIComponent(itemKey)}`, { collections: [...existing] }, {
      write: true,
      headers: { 'If-Unmodified-Since-Version': String(current.version ?? 0) },
    });
  }

  /**
   * 上传 PDF 附件（四段流程，移植 Read-Studio importPdfAttachment）：
   *  1. 创建 attachment 子条目（md5/mtime 置空）
   *  2. 请求上传授权（If-None-Match: *；同文件已存在则 auth.exists → 跳过上传）
   *  3. 直传文件内容（auth.url 优先，否则 PUT 到 /file）
   *  4. 带 uploadKey 时注册上传完成
   */
  async uploadPdfAttachment(filePath: string, parentItemKey: string, options: {
    title?: string;
    libraryKey?: string;
  } = {}): Promise<{ attachmentKey: string; duplicate: boolean }> {
    const prefix = libraryPrefix(options.libraryKey);
    const [fileBytes, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
    const filename = basename(filePath);
    const md5 = createHash('md5').update(fileBytes).digest('hex');
    const mtime = Math.round(fileStat.mtimeMs);

    // 1. 创建附件子条目
    const created = record(await this.post(`${prefix}/items`, [{
      itemType: 'attachment',
      linkMode: 'imported_file',
      parentItem: parentItemKey,
      title: options.title ?? filename.replace(/\.pdf$/i, ''),
      contentType: 'application/pdf',
      filename,
      md5: null,
      mtime: null,
    }], { write: true }));
    const attachKey = record(record(created.successful)['0']).key;
    if (typeof attachKey !== 'string' || !attachKey) {
      throw new ZoteroApiError(`创建附件条目失败: ${JSON.stringify(created).slice(0, 200)}`, 'http');
    }

    // 2. 上传授权
    const authRes = (await this.request('POST', `${prefix}/items/${attachKey}/file`, {
      write: true,
      raw: true,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'If-None-Match': '*' },
      body: new URLSearchParams({ md5, filename, filesize: String(fileBytes.byteLength), mtime: String(mtime) }).toString(),
    })) as Response;
    const auth = record(await authRes.json());
    if (auth.exists) return { attachmentKey: attachKey, duplicate: true };

    // 3. 直传文件
    const uploadUrl = typeof auth.url === 'string' && auth.url
      ? (auth.url.startsWith('http') ? auth.url : `${this.baseUrl}${auth.url}`)
      : `${this.baseUrl}${prefix}/items/${attachKey}/file`;
    const upRes = await this.fetchImpl(uploadUrl, {
      method: typeof auth.url === 'string' && auth.url ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(fileBytes.byteLength), Connection: 'close' },
      body: fileBytes,
    });
    if (!upRes.ok && upRes.status !== 201 && upRes.status !== 204) {
      const detail = await upRes.text().catch(() => '');
      throw new ZoteroApiError(`PDF 上传失败（HTTP ${upRes.status}）: ${detail.slice(0, 200)}`, 'http', upRes.status);
    }

    // 4. 注册上传
    if (typeof auth.uploadKey === 'string' && auth.uploadKey) {
      await this.request('POST', `${prefix}/items/${attachKey}/file`, {
        write: true,
        raw: true,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `upload=${encodeURIComponent(auth.uploadKey)}`,
      });
    }
    return { attachmentKey: attachKey, duplicate: false };
  }

  /** 删除条目（进回收站；If-Unmodified-Since-Version 乐观锁）。主要供测试清理。 */
  async deleteItem(itemKey: string, options: { libraryKey?: string } = {}): Promise<void> {
    const prefix = libraryPrefix(options.libraryKey);
    const current = record(await this.get(`${prefix}/items/${encodeURIComponent(itemKey)}`));
    await this.request('DELETE', `${prefix}/items/${encodeURIComponent(itemKey)}`, {
      write: true,
      raw: true,
      headers: { 'If-Unmodified-Since-Version': String(current.version ?? 0) },
    });
  }
}

/** libraryKey: undefined/'user' → /users/0；'group:<id>' → /groups/<id> */
function libraryPrefix(libraryKey?: string): string {
  if (!libraryKey || libraryKey === 'user') return '/users/0';
  if (libraryKey.startsWith('group:')) return `/groups/${encodeURIComponent(libraryKey.slice(6))}`;
  return '/users/0';
}
