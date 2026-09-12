// dist/core/dedupe.js
function normalizeDoi(value) {
  return decodeURIComponent(value.trim()).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").replace(/[\s.,;:)>\]}]+$/, "").toLowerCase();
}
function extractDoi(value) {
  const match = value.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? normalizeDoi(match[0]) : void 0;
}
function foldForMatch(value) {
  return value.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}
function titlesAlign(left, right) {
  const a = foldForMatch(left);
  const b = foldForMatch(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}
function dedupeWorks(items) {
  const seen = /* @__PURE__ */ new Set();
  return items.filter((item) => {
    const key = item.doi || `${foldForMatch(item.title)}:${item.year ?? ""}`;
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}

// dist/core/ratelimit.js
var ProviderError = class extends Error {
  code;
  temporary;
  status;
  constructor(message, code, temporary, status = 502) {
    super(message);
    this.code = code;
    this.temporary = temporary;
    this.status = status;
    this.name = "ProviderError";
  }
};
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var RateLimiter = class {
  tail = Promise.resolve(0);
  intervalMs;
  sleep;
  now;
  constructor(options) {
    this.intervalMs = Math.max(0, options.intervalMs);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }
  /** 等到轮到自己且距上次放行已满 intervalMs，然后放行。 */
  acquire() {
    const turn = this.tail.then(async (lastRelease) => {
      const wait = this.intervalMs - (this.now() - lastRelease);
      if (wait > 0)
        await this.sleep(wait);
      return this.now();
    });
    this.tail = turn.catch(() => this.now());
    return turn.then(() => void 0);
  }
};
function userAgent() {
  return "literature-search-agent/0.1 (https://github.com/literature-search-agent)";
}
async function abortableSleep(ms, signal) {
  if (ms <= 0)
    return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    }, { once: true });
  });
}
function retryAfterMs(response, attempt) {
  const header = Number(response.headers.get("retry-after") || 0);
  const fromHeader = Number.isFinite(header) && header > 0 ? header * 1e3 : 0;
  const backoff = 800 * 2 ** attempt;
  return fromHeader > 0 ? Math.min(1e4, Math.max(1e3, fromHeader)) : backoff;
}
async function requestJson(url, options) {
  const { provider, limiter: limiter2, fetchImpl = fetch, signal, headers = {}, maxAttempts = 2, timeoutMs = 2e4, responseAs = "json" } = options;
  const requestHeaders = {
    Accept: responseAs === "text" ? "application/atom+xml, text/xml;q=0.9, text/html;q=0.8" : "application/json",
    "User-Agent": userAgent(),
    ...headers
  };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await limiter2?.acquire();
    let response;
    try {
      response = await fetchImpl(url, {
        headers: requestHeaders,
        signal: signal ?? AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (signal?.aborted)
        throw error;
      if (attempt < maxAttempts - 1) {
        await abortableSleep(800 * 2 ** attempt, signal);
        continue;
      }
      throw new ProviderError(`${provider} \u8FDE\u63A5\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`, "provider_unavailable", true);
    }
    if (response.ok)
      return responseAs === "text" ? response.text() : response.json();
    if (response.status === 404)
      return void 0;
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(`${provider} \u8BA4\u8BC1\u5931\u8D25\u6216\u8BF7\u6C42\u88AB\u62D2\u7EDD\uFF08HTTP ${response.status}\uFF09\u3002`, "auth_failed", false, response.status);
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt < maxAttempts - 1) {
        await abortableSleep(retryAfterMs(response, attempt), signal);
        continue;
      }
      throw new ProviderError(`${provider} \u6682\u65F6\u4E0D\u53EF\u7528\uFF08HTTP ${response.status}\uFF09\u3002`, response.status === 429 ? "rate_limited" : "provider_unavailable", true, response.status);
    }
    throw new ProviderError(`${provider} \u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09\u3002`, "bad_request", false, response.status);
  }
  throw new ProviderError(`${provider} \u8BF7\u6C42\u5931\u8D25\u3002`, "provider_unavailable", true);
}
async function requestText(url, options) {
  const value = await requestJson(url, { ...options, responseAs: "text" });
  return typeof value === "string" ? value : "";
}

// dist/core/providers/openalex.js
var API_BASE = "https://api.openalex.org";
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function invertOpenAlexAbstract(index) {
  if (!index)
    return "";
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions)
      words[position] = word;
  }
  return words.filter(Boolean).join(" ").trim();
}
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
function mapOpenAlexWork(value) {
  const work = record(value);
  const title = text(work.title) || text(work.display_name);
  if (!title)
    return void 0;
  const authorships = Array.isArray(work.authorships) ? work.authorships : [];
  const authors = authorships.flatMap((entry) => {
    const name = text(record(record(entry).author).display_name);
    return name ? [name] : [];
  });
  const primary = record(work.primary_location);
  const source = record(primary.source);
  const bestOa = record(work.best_oa_location);
  const ids = record(work.ids);
  const doi = text(work.doi) ? normalizeDoi(text(work.doi)) : "";
  const abstract = invertOpenAlexAbstract(work.abstract_inverted_index).slice(0, 1e5);
  const externalIds = {};
  const openalexId = text(work.id);
  if (openalexId)
    externalIds.openalex = openalexId;
  if (doi)
    externalIds.doi = doi;
  for (const key of ["mag", "pmid"]) {
    const id = text(ids[key]);
    if (id)
      externalIds[key] = id;
  }
  return {
    title,
    authors: [...new Set(authors)].slice(0, 30),
    year: typeof work.publication_year === "number" ? work.publication_year : null,
    venue: text(source.display_name),
    doi,
    url: text(primary.landing_page_url) || openalexId,
    citationCount: typeof work.cited_by_count === "number" && work.cited_by_count >= 0 ? work.cited_by_count : null,
    abstract,
    abstractStatus: abstract ? "complete" : "pending",
    oaPdfUrl: text(bestOa.pdf_url) || text(primary.pdf_url),
    source: "openalex",
    externalIds
  };
}
function resolveAuth(auth) {
  const apiKey = auth.apiKey?.trim();
  if (apiKey)
    return { tier: "api_key", apply: (url) => url.searchParams.set("api_key", apiKey) };
  const mailto = auth.mailto?.trim();
  if (mailto)
    return { tier: "mailto", apply: (url) => url.searchParams.set("mailto", mailto) };
  return { tier: "anonymous", apply: () => void 0 };
}
var limiters = /* @__PURE__ */ new Map();
function limiterFor(tier) {
  const cached = limiters.get(tier);
  if (cached)
    return cached;
  const limiter2 = new RateLimiter({ intervalMs: tier === "anonymous" ? 500 : 100 });
  limiters.set(tier, limiter2);
  return limiter2;
}
async function openAlexGet(url, options) {
  const auth = resolveAuth(options);
  auth.apply(url);
  return requestJson(url, {
    provider: "openalex",
    limiter: limiterFor(auth.tier),
    ...options.fetchImpl !== void 0 ? { fetchImpl: options.fetchImpl } : {},
    ...options.signal !== void 0 ? { signal: options.signal } : {}
  });
}
function resultsOf(value) {
  const results = record(value).results;
  return Array.isArray(results) ? results : [];
}
function diagnostics(error) {
  return {
    openalex: {
      ok: false,
      count: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  };
}
function clampLimit(limit, fallback) {
  return Math.min(Math.max(limit ?? fallback, 1), 200);
}
function yearFilter(options) {
  if (options.yearFrom && options.yearTo)
    return `publication_year:${options.yearFrom}-${options.yearTo}`;
  if (options.yearFrom)
    return `publication_year:>${options.yearFrom - 1}`;
  if (options.yearTo)
    return `publication_year:<${options.yearTo + 1}`;
  return "";
}
async function searchOpenAlex(query, options = {}) {
  const q = query.replace(/\s+/g, " ").trim();
  if (!q)
    throw new ProviderError("\u68C0\u7D22\u8BCD\u4E0D\u80FD\u4E3A\u7A7A\u3002", "bad_request", false, 400);
  const limit = clampLimit(options.limit, 10);
  const url = new URL(`${API_BASE}/works`);
  url.searchParams.set("search", q);
  url.searchParams.set("per_page", String(limit));
  const years = yearFilter(options);
  if (years)
    url.searchParams.set("filter", years);
  try {
    const value = await openAlexGet(url, options);
    const items = dedupeWorks(resultsOf(value).flatMap((raw) => {
      const item = mapOpenAlexWork(raw);
      return item ? [item] : [];
    })).slice(0, limit);
    return { items, diagnostics: { openalex: { ok: true, count: items.length } } };
  } catch (error) {
    return { items: [], diagnostics: diagnostics(error) };
  }
}
async function lookupOpenAlexByDoi(doi, options = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized)
    throw new ProviderError("DOI \u4E0D\u80FD\u4E3A\u7A7A\u3002", "bad_request", false, 400);
  const url = new URL(`${API_BASE}/works/doi:${encodeURIComponent(normalized)}`);
  const value = await openAlexGet(url, options);
  return value === void 0 ? void 0 : mapOpenAlexWork(value);
}
async function citedByOpenAlex(doiOrOpenAlexId, options = {}) {
  let openAlexId = doiOrOpenAlexId.trim();
  if (!/^https?:\/\/openalex\.org\/W\d+$/i.test(openAlexId) && !/^W\d+$/i.test(openAlexId)) {
    const work = await lookupOpenAlexByDoi(openAlexId, options);
    if (!work?.externalIds.openalex) {
      return {
        items: [],
        diagnostics: { openalex: { ok: false, count: 0, error: `\u65E0\u6CD5\u89E3\u6790 "${doiOrOpenAlexId}" \u4E3A OpenAlex work\u3002` } }
      };
    }
    openAlexId = work.externalIds.openalex;
  }
  const limit = clampLimit(options.limit, 25);
  const url = new URL(`${API_BASE}/works`);
  url.searchParams.set("filter", `cites:${openAlexId}`);
  url.searchParams.set("per_page", String(limit));
  try {
    const value = await openAlexGet(url, options);
    const items = dedupeWorks(resultsOf(value).flatMap((raw) => {
      const item = mapOpenAlexWork(raw);
      return item ? [item] : [];
    })).slice(0, limit);
    return { items, diagnostics: { openalex: { ok: true, count: items.length } } };
  } catch (error) {
    return { items: [], diagnostics: diagnostics(error) };
  }
}

// dist/core/providers/semanticscholar.js
var API_BASE2 = "https://api.semanticscholar.org/graph/v1";
var FIELDS = "title,authors.name,year,venue,externalIds,abstract,citationCount,openAccessPdf,url";
function record2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text2(value) {
  return typeof value === "string" ? value.trim() : "";
}
function mapS2Paper(value) {
  const paper = record2(value);
  const title = text2(paper.title);
  if (!title)
    return void 0;
  const authors = (Array.isArray(paper.authors) ? paper.authors : []).flatMap((entry) => {
    const name = text2(record2(entry).name);
    return name ? [name] : [];
  });
  const ids = record2(paper.externalIds);
  const doi = text2(ids.DOI) ? normalizeDoi(text2(ids.DOI)) : "";
  const oaPdf = record2(paper.openAccessPdf);
  const externalIds = {};
  const paperId = text2(paper.paperId);
  if (paperId)
    externalIds.s2 = paperId;
  if (doi)
    externalIds.doi = doi;
  const arxiv = text2(ids.ArXiv);
  if (arxiv)
    externalIds.arxiv = arxiv;
  const abstract = text2(paper.abstract).replace(/\s+/g, " ").slice(0, 1e5);
  return {
    title,
    authors: [...new Set(authors)].slice(0, 30),
    year: typeof paper.year === "number" ? paper.year : null,
    venue: text2(paper.venue),
    doi,
    url: text2(paper.url),
    citationCount: typeof paper.citationCount === "number" && paper.citationCount >= 0 ? paper.citationCount : null,
    abstract,
    abstractStatus: abstract ? "complete" : "pending",
    oaPdfUrl: text2(oaPdf.url),
    source: "semanticscholar",
    externalIds
  };
}
var limiters2 = /* @__PURE__ */ new Map();
function limiterFor2(hasKey) {
  const tier = hasKey ? "key" : "anonymous";
  const cached = limiters2.get(tier);
  if (cached)
    return cached;
  const limiter2 = new RateLimiter({ intervalMs: hasKey ? 1e3 : 3e3 });
  limiters2.set(tier, limiter2);
  return limiter2;
}
async function s2Get(url, options) {
  const apiKey = options.apiKey?.trim();
  return requestJson(url, {
    provider: "semantic_scholar",
    limiter: limiterFor2(Boolean(apiKey)),
    headers: apiKey ? { "x-api-key": apiKey } : {},
    ...options.fetchImpl !== void 0 ? { fetchImpl: options.fetchImpl } : {},
    ...options.signal !== void 0 ? { signal: options.signal } : {}
  });
}
function diagnostics2(error) {
  return {
    semanticscholar: {
      ok: false,
      count: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  };
}
async function searchSemanticScholar(query, options = {}) {
  const q = query.replace(/\s+/g, " ").trim();
  if (!q)
    throw new ProviderError("\u68C0\u7D22\u8BCD\u4E0D\u80FD\u4E3A\u7A7A\u3002", "bad_request", false, 400);
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  const url = new URL(`${API_BASE2}/paper/search`);
  url.searchParams.set("query", q);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", FIELDS);
  if (options.yearFrom || options.yearTo) {
    url.searchParams.set("year", `${options.yearFrom ?? ""}-${options.yearTo ?? ""}`);
  }
  try {
    const value = await s2Get(url, options);
    const data = record2(value).data;
    const items = dedupeWorks((Array.isArray(data) ? data : []).flatMap((raw) => {
      const item = mapS2Paper(raw);
      return item ? [item] : [];
    })).slice(0, limit);
    return { items, diagnostics: { semanticscholar: { ok: true, count: items.length } } };
  } catch (error) {
    return { items: [], diagnostics: diagnostics2(error) };
  }
}
async function lookupS2ByDoi(doi, options = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized)
    throw new ProviderError("DOI \u4E0D\u80FD\u4E3A\u7A7A\u3002", "bad_request", false, 400);
  const url = new URL(`${API_BASE2}/paper/DOI:${encodeURIComponent(normalized)}`);
  url.searchParams.set("fields", FIELDS);
  const value = await s2Get(url, options);
  return value === void 0 ? void 0 : mapS2Paper(value);
}

// dist/core/providers/crossref.js
var API_BASE3 = "https://api.crossref.org";
function record3(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text3(value) {
  return typeof value === "string" ? value.trim() : "";
}
function cleanCrossrefAbstract(value) {
  if (!value)
    return "";
  return value.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
function mapCrossrefWork(value) {
  const message = record3(value);
  const titleField = message.title;
  const title = Array.isArray(titleField) ? text3(titleField[0]) : text3(titleField);
  if (!title)
    return void 0;
  const authors = (Array.isArray(message.author) ? message.author : []).flatMap((entry) => {
    const author = record3(entry);
    const name = [author.given, author.family].filter((part) => typeof part === "string").join(" ").trim();
    return name ? [name] : [];
  });
  const published = record3(message.published);
  const dateParts = Array.isArray(published["date-parts"]) ? published["date-parts"] : [];
  const firstDate = dateParts[0];
  const year = typeof firstDate?.[0] === "number" ? firstDate[0] : null;
  const containerTitle = message["container-title"];
  const venue = Array.isArray(containerTitle) ? text3(containerTitle[0]) : "";
  const doi = text3(message.DOI) ? normalizeDoi(text3(message.DOI)) : "";
  const abstract = cleanCrossrefAbstract(text3(message.abstract) || void 0).slice(0, 1e5);
  const oaPdfUrl = (Array.isArray(message.link) ? message.link : []).flatMap((entry) => {
    const link = record3(entry);
    if (!/application\/pdf/i.test(text3(link["content-type"])))
      return [];
    const url = text3(link.URL);
    return url ? [url.replace(/^http:/i, "https:")] : [];
  })[0] ?? "";
  const externalIds = {};
  if (doi)
    externalIds.doi = doi;
  return {
    title,
    authors: [...new Set(authors)].slice(0, 30),
    year,
    venue,
    doi,
    url: text3(message.URL),
    citationCount: typeof message["is-referenced-by-count"] === "number" ? message["is-referenced-by-count"] : null,
    abstract,
    abstractStatus: abstract ? "complete" : "pending",
    oaPdfUrl,
    source: "crossref",
    externalIds
  };
}
var limiters3 = /* @__PURE__ */ new Map();
function limiterFor3(hasMailto) {
  const tier = hasMailto ? "mailto" : "anonymous";
  const cached = limiters3.get(tier);
  if (cached)
    return cached;
  const limiter2 = new RateLimiter({ intervalMs: hasMailto ? 100 : 1e3 });
  limiters3.set(tier, limiter2);
  return limiter2;
}
async function crossrefGet(url, options) {
  const mailto = options.mailto?.trim();
  if (mailto)
    url.searchParams.set("mailto", mailto);
  return requestJson(url, {
    provider: "crossref",
    limiter: limiterFor3(Boolean(mailto)),
    ...options.fetchImpl !== void 0 ? { fetchImpl: options.fetchImpl } : {},
    ...options.signal !== void 0 ? { signal: options.signal } : {}
  });
}
function diagnostics3(error) {
  return {
    crossref: {
      ok: false,
      count: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  };
}
function messageItems(value) {
  const items = record3(record3(value).message).items;
  return Array.isArray(items) ? items : [];
}
async function searchCrossref(query, options = {}) {
  const q = query.replace(/\s+/g, " ").trim();
  if (!q)
    throw new ProviderError("\u68C0\u7D22\u8BCD\u4E0D\u80FD\u4E3A\u7A7A\u3002", "bad_request", false, 400);
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  const url = new URL(`${API_BASE3}/works`);
  url.searchParams.set("query.bibliographic", q);
  const author = options.author?.trim();
  if (author)
    url.searchParams.set("query.author", author);
  url.searchParams.set("rows", String(limit));
  const filters = [];
  if (options.yearFrom)
    filters.push(`from-pub-date:${options.yearFrom}-01-01`);
  if (options.yearTo)
    filters.push(`until-pub-date:${options.yearTo}-12-31`);
  if (filters.length)
    url.searchParams.set("filter", filters.join(","));
  try {
    const value = await crossrefGet(url, options);
    const items = dedupeWorks(messageItems(value).flatMap((raw) => {
      const item = mapCrossrefWork(raw);
      return item ? [item] : [];
    })).slice(0, limit);
    return { items, diagnostics: { crossref: { ok: true, count: items.length } } };
  } catch (error) {
    return { items: [], diagnostics: diagnostics3(error) };
  }
}
async function lookupCrossrefByDoi(doi, options = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized)
    throw new ProviderError("DOI \u4E0D\u80FD\u4E3A\u7A7A\u3002", "bad_request", false, 400);
  const url = new URL(`${API_BASE3}/works/${encodeURIComponent(normalized)}`);
  const value = await crossrefGet(url, options);
  return value === void 0 ? void 0 : mapCrossrefWork(record3(value).message);
}

// dist/core/providers/unpaywall.js
function record4(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text4(value) {
  return typeof value === "string" ? value.trim() : "";
}
function mapLocation(value, isBest) {
  const location = record4(value);
  return {
    pdfUrl: text4(location.url_for_pdf),
    landingUrl: text4(location.url_for_landing_page) || text4(location.url),
    hostType: text4(location.host_type),
    license: text4(location.license),
    isBest
  };
}
var limiter = new RateLimiter({ intervalMs: 100 });
async function lookupUnpaywall(doi, options = {}) {
  const normalized = normalizeDoi(doi);
  if (!normalized)
    throw new ProviderError("DOI \u4E0D\u80FD\u4E3A\u7A7A\u3002", "bad_request", false, 400);
  const email = options.email?.trim();
  if (!email)
    throw new ProviderError("Unpaywall \u9700\u8981\u914D\u7F6E\u8054\u7CFB\u90AE\u7BB1\uFF08LIT_SEARCH_MAILTO\uFF09\u3002", "bad_request", false, 400);
  const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(normalized)}`);
  url.searchParams.set("email", email);
  const value = await requestJson(url, {
    provider: "unpaywall",
    limiter,
    ...options.fetchImpl !== void 0 ? { fetchImpl: options.fetchImpl } : {},
    ...options.signal !== void 0 ? { signal: options.signal } : {}
  });
  if (value === void 0)
    return void 0;
  const raw = record4(value);
  const best = raw.best_oa_location;
  const locations = [];
  if (best && typeof best === "object")
    locations.push(mapLocation(best, true));
  for (const entry of Array.isArray(raw.oa_locations) ? raw.oa_locations : []) {
    const mapped = mapLocation(entry, false);
    if (!locations.some((l) => l.pdfUrl === mapped.pdfUrl && l.landingUrl === mapped.landingUrl)) {
      locations.push(mapped);
    }
  }
  return {
    doi: normalized,
    isOa: raw.is_oa === true,
    bestPdfUrl: locations[0]?.pdfUrl ?? "",
    bestLandingUrl: locations[0]?.landingUrl ?? "",
    locations
  };
}

// dist/core/enrich/html.js
function cleanMarkup(value) {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim();
}
function safeOpenAccessUrl(value) {
  if (!value)
    return void 0;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || /^(localhost|127\.|0\.0\.0\.0|::1$)/i.test(url.hostname))
      return void 0;
    return url;
  } catch {
    return void 0;
  }
}
function htmlAbstract(value) {
  const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"))?.[2];
  const meta = [...value.matchAll(/<meta\b[^>]*>/gi)].find((tag) => {
    const key = attribute(tag[0], "name") || attribute(tag[0], "property");
    return /^(?:citation_abstract|dc\.description|description|og:description)$/i.test(key || "");
  });
  const metaDescription = meta ? attribute(meta[0], "content") : void 0;
  const jsonLdDescriptions = [...value.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].flatMap((match) => {
    try {
      const parsed = JSON.parse(match[1] ?? "");
      const values = Array.isArray(parsed) ? parsed : [parsed];
      return values.flatMap((item) => item && typeof item === "object" && typeof item.description === "string" ? [item.description] : []);
    } catch {
      return [];
    }
  });
  const section = value.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/i)?.[1] || value.match(/<(?:section|div)[^>]+(?:class|id)=["'][^"']*abstract[^"']*["'][^>]*>([\s\S]*?)<\/(?:section|div)>/i)?.[1];
  return cleanMarkup(metaDescription || jsonLdDescriptions[0] || section || "");
}
var MAX_HTML_BYTES = 2e6;
async function openAccessHtmlAbstract(pageUrl, options = {}) {
  const url = safeOpenAccessUrl(pageUrl);
  if (!url)
    return "";
  const body = await requestText(url, {
    provider: "open_access",
    maxAttempts: 1,
    // 落地页重试价值低，失败直接降级
    ...options.fetchImpl !== void 0 ? { fetchImpl: options.fetchImpl } : {},
    ...options.signal !== void 0 ? { signal: options.signal } : {}
  }).catch((error) => {
    if (error instanceof ProviderError)
      return "";
    throw error;
  });
  if (!body || body.length > MAX_HTML_BYTES)
    return "";
  return htmlAbstract(body).slice(0, 1e5);
}

// dist/core/enrich/sources.js
function record5(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function cleanMarkup2(value) {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim();
}
var europePmcLimiter = new RateLimiter({ intervalMs: 200 });
var arxivLimiter = new RateLimiter({ intervalMs: 3e3 });
async function europePmcAbstract(doi, options = {}) {
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", `DOI:${doi}`);
  url.searchParams.set("format", "json");
  url.searchParams.set("resultType", "core");
  url.searchParams.set("pageSize", "1");
  const value = await requestJson(url, {
    provider: "europe_pmc",
    limiter: europePmcLimiter,
    ...options.fetchImpl !== void 0 ? { fetchImpl: options.fetchImpl } : {},
    ...options.signal !== void 0 ? { signal: options.signal } : {}
  });
  const resultList = record5(record5(value).resultList).result;
  const first = record5(Array.isArray(resultList) ? resultList[0] : void 0);
  const abstract = typeof first.abstractText === "string" ? cleanMarkup2(first.abstractText) : "";
  return abstract.slice(0, 1e5);
}
async function arxivAbstract(doi, options = {}) {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `doi:${doi}`);
  url.searchParams.set("max_results", "1");
  const xml = await requestText(url, {
    provider: "arxiv",
    limiter: arxivLimiter,
    ...options.fetchImpl !== void 0 ? { fetchImpl: options.fetchImpl } : {},
    ...options.signal !== void 0 ? { signal: options.signal } : {}
  });
  const summary = xml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || "";
  return cleanMarkup2(summary).slice(0, 1e5);
}

// dist/core/enrich/abstract.js
function settled(result) {
  return result.status === "fulfilled" ? result.value : void 0;
}
async function enrichAbstract(input, options = {}) {
  let doi = input.doi ? normalizeDoi(input.doi) : "";
  const fetchOpts = {
    ...options.fetchImpl !== void 0 ? { fetchImpl: options.fetchImpl } : {},
    ...options.signal !== void 0 ? { signal: options.signal } : {}
  };
  const partials = [];
  if (!doi && input.title.trim()) {
    const [openalex2, crossref2] = await Promise.allSettled([
      searchOpenAlex(input.title, { limit: 3, ...fetchOpts }),
      searchCrossref(input.title, { limit: 3, ...input.authors?.[0] ? { author: input.authors[0] } : {}, ...fetchOpts })
    ]);
    const candidates = [...settled(openalex2)?.items ?? [], ...settled(crossref2)?.items ?? []];
    const match = candidates.find((c) => c.doi && titlesAlign(c.title, input.title));
    if (match) {
      doi = match.doi;
      if (match.abstract)
        partials.push({ abstract: match.abstract, source: match.source });
    }
  }
  if (!doi)
    return { abstract: "", source: "", status: "missing", doi: "" };
  const [openalex, crossref] = await Promise.allSettled([
    lookupOpenAlexByDoi(doi, { ...options.openAlexApiKey ? { apiKey: options.openAlexApiKey } : {}, ...options.mailto ? { mailto: options.mailto } : {}, ...fetchOpts }),
    lookupCrossrefByDoi(doi, { ...options.mailto ? { mailto: options.mailto } : {}, ...fetchOpts })
  ]);
  const openalexWork = settled(openalex);
  if (openalexWork?.abstract)
    return { abstract: openalexWork.abstract, source: "openalex", status: "complete", doi };
  const crossrefWork = settled(crossref);
  if (crossrefWork?.abstract)
    return { abstract: crossrefWork.abstract, source: "crossref", status: "complete", doi };
  const [s2, epmc, arxiv] = await Promise.allSettled([
    lookupS2ByDoi(doi, { ...options.s2ApiKey ? { apiKey: options.s2ApiKey } : {}, ...fetchOpts }).then((w) => w?.abstract ?? ""),
    europePmcAbstract(doi, fetchOpts),
    arxivAbstract(doi, fetchOpts)
  ]);
  const priority = [
    { result: s2, source: "semanticscholar" },
    { result: epmc, source: "europe_pmc" },
    { result: arxiv, source: "arxiv" }
  ];
  for (const { result, source } of priority) {
    const abstract = settled(result);
    if (abstract)
      return { abstract, source, status: "complete", doi };
  }
  const landing = await openAccessHtmlAbstract(`https://doi.org/${encodeURIComponent(doi)}`, fetchOpts).catch(() => "");
  if (landing)
    return { abstract: landing, source: "open_access", status: "complete", doi };
  if (options.mailto) {
    const unpaywall = await lookupUnpaywall(doi, { email: options.mailto, ...fetchOpts }).catch(() => void 0);
    for (const location of unpaywall?.locations ?? []) {
      const abstract = await openAccessHtmlAbstract(location.landingUrl || location.pdfUrl, fetchOpts).catch(() => "");
      if (abstract)
        return { abstract, source: "unpaywall", status: "complete", doi };
    }
  }
  const best = partials.sort((a, b) => b.abstract.length - a.abstract.length)[0];
  if (best)
    return { abstract: best.abstract, source: best.source, status: "complete", doi };
  return { abstract: "", source: "", status: "missing", doi };
}

// dist/core/pdf/discover.js
async function discoverOaPdfUrl(work, options = {}) {
  if (work.oaPdfUrl)
    return work.oaPdfUrl;
  const doi = normalizeDoi(work.doi);
  if (!doi)
    return "";
  const fetchOpts = {
    ...options.fetchImpl !== void 0 ? { fetchImpl: options.fetchImpl } : {},
    ...options.signal !== void 0 ? { signal: options.signal } : {}
  };
  const openalex = await lookupOpenAlexByDoi(doi, {
    ...options.openAlexApiKey ? { apiKey: options.openAlexApiKey } : {},
    ...options.mailto ? { mailto: options.mailto } : {},
    ...fetchOpts
  }).catch(() => void 0);
  if (openalex?.oaPdfUrl)
    return openalex.oaPdfUrl;
  if (options.mailto) {
    const unpaywall = await lookupUnpaywall(doi, { email: options.mailto, ...fetchOpts }).catch(() => void 0);
    if (unpaywall?.bestPdfUrl)
      return unpaywall.bestPdfUrl;
    const anyPdf = unpaywall?.locations.find((l) => l.pdfUrl);
    if (anyPdf)
      return anyPdf.pdfUrl;
  }
  return "";
}

// dist/core/pdf/download.js
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
var MAX_PDF_BYTES = 3e7;
function normalizePdfUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError(`\u65E0\u6548\u7684 PDF URL\uFF1A${value}`, "bad_request", false, 400);
  }
  if (url.protocol === "http:")
    url.protocol = "https:";
  if (url.protocol !== "https:" || /^(localhost|127\.|0\.0\.0\.0|::1$)/i.test(url.hostname)) {
    throw new ProviderError(`\u4E0D\u5141\u8BB8\u7684 PDF URL\uFF1A${value}`, "bad_request", false, 400);
  }
  return url;
}
async function downloadPdf(pdfUrl, destPath, options = {}) {
  const url = normalizePdfUrl(pdfUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/pdf",
      "User-Agent": "literature-search-agent/0.1 (https://github.com/literature-search-agent)"
    },
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 6e4)
  }).catch((error) => {
    throw new ProviderError(`PDF \u4E0B\u8F7D\u8FDE\u63A5\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`, "provider_unavailable", true);
  });
  if (!response.ok) {
    throw new ProviderError(`PDF \u4E0B\u8F7D\u5931\u8D25\uFF08HTTP ${response.status}\uFF09\u3002`, "provider_unavailable", response.status >= 500, response.status);
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_PDF_BYTES) {
    throw new ProviderError(`PDF \u8FC7\u5927\uFF08${declared} \u5B57\u8282\uFF0C\u4E0A\u9650 ${MAX_PDF_BYTES}\uFF09\u3002`, "bad_request", false, 413);
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType && !/application\/pdf|application\/octet-stream|binary/i.test(contentType) && !/\.pdf(?:$|[?#])/i.test(url.pathname)) {
    throw new ProviderError(`\u54CD\u5E94\u4E0D\u662F PDF\uFF08content-type: ${contentType}\uFF09\u3002`, "bad_request", false, 415);
  }
  if (!response.body)
    throw new ProviderError("PDF \u54CD\u5E94\u65E0 body\u3002", "provider_unavailable", true);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new ProviderError(`PDF \u8FC7\u5927\uFF08${bytes.byteLength} \u5B57\u8282\uFF0C\u4E0A\u9650 ${MAX_PDF_BYTES}\uFF09\u3002`, "bad_request", false, 413);
  }
  const magic = new TextDecoder().decode(bytes.slice(0, 5));
  if (magic !== "%PDF-") {
    throw new ProviderError("\u54CD\u5E94\u5185\u5BB9\u4E0D\u662F PDF\uFF08\u7F3A\u5C11 %PDF- \u9B54\u6570\uFF0C\u53EF\u80FD\u662F HTML \u767B\u5F55\u5899\uFF09\u3002", "bad_request", false, 415);
  }
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, bytes);
  return { path: destPath, bytes: bytes.byteLength, url: url.toString() };
}
async function streamPdfToFile(pdfUrl, destPath) {
  const url = normalizePdfUrl(pdfUrl);
  const response = await fetch(url, { signal: AbortSignal.timeout(12e4) });
  if (!response.ok || !response.body)
    throw new ProviderError(`PDF \u4E0B\u8F7D\u5931\u8D25\uFF08HTTP ${response.status}\uFF09\u3002`, "provider_unavailable", response.status >= 500, response.status);
  await mkdir(dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
}

// dist/core/pdf/extract.js
import { readFile } from "node:fs/promises";
var DEFAULT_MAX_CHARS = 2e5;
async function pdfParseExtract(data, maxPages) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText(maxPages ? { first: maxPages } : {});
    return { text: result.text, pageCount: result.total, parsedPages: result.pages.length };
  } finally {
    await parser.destroy();
  }
}
async function extractPdfText(input, options = {}) {
  const data = typeof input === "string" ? new Uint8Array(await readFile(input)) : input;
  const extractor = options.extractor ?? pdfParseExtract;
  const { text: text5, pageCount, parsedPages } = await extractor(data, options.maxPages);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const truncated = text5.length > maxChars;
  return {
    text: truncated ? text5.slice(0, maxChars) : text5,
    pageCount,
    parsedPages,
    truncated
  };
}

// dist/core/zotero/client.js
import { createHash } from "node:crypto";
import { readFile as readFile2, stat } from "node:fs/promises";
import { basename } from "node:path";
var DEFAULT_BASE_URL = "http://localhost:23119/api";
var MIN_WRITE_MAJOR_VERSION = 10;
var ZoteroApiError = class extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "ZoteroApiError";
  }
};
function record6(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function extractYear(dateStr) {
  const match = String(dateStr ?? "").match(/(19|20)\d{2}/);
  return match ? parseInt(match[0], 10) : null;
}
function creatorsToAuthors(creators) {
  if (!Array.isArray(creators))
    return [];
  return creators.flatMap((c) => {
    const creator = record6(c);
    if (typeof creator.name === "string" && creator.name)
      return [creator.name];
    const name = [creator.firstName, creator.lastName].filter((p) => typeof p === "string" && Boolean(p)).join(" ");
    return name ? [name] : [];
  });
}
var ZoteroClient = class {
  baseUrl;
  apiKey;
  autoAuthorize;
  appName;
  fetchImpl;
  serverId = null;
  /** Zotero 版本号（从响应头学习） */
  zoteroVersion = "";
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (options.apiKey?.trim())
      this.apiKey = options.apiKey.trim();
    this.autoAuthorize = options.autoAuthorize ?? false;
    this.appName = options.appName ?? "literature-search-agent";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }
  recordHeaders(res) {
    const sid = res.headers.get("Zotero-Server-ID");
    if (sid)
      this.serverId = sid;
    const ver = res.headers.get("X-Zotero-Version");
    if (ver)
      this.zoteroVersion = ver;
  }
  async request(method, path, opts = {}) {
    const headers = { Accept: "application/json", ...opts.headers };
    headers["Connection"] = "close";
    let body;
    if (opts.body !== void 0) {
      if (typeof opts.body === "string" || opts.body instanceof Uint8Array) {
        body = opts.body;
      } else {
        headers["Content-Type"] = "application/json; charset=utf-8";
        body = JSON.stringify(opts.body);
      }
    }
    if (opts.write) {
      if (!this.serverId)
        await this.ping();
      if (!this.serverId)
        throw new ZoteroApiError("\u65E0\u6CD5\u83B7\u53D6 Zotero Server-ID\u3002", "offline");
      headers["Zotero-Server-ID"] = this.serverId;
      if (this.apiKey)
        headers["Zotero-API-Key"] = this.apiKey;
    }
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, ...body !== void 0 ? { body } : {} });
    } catch {
      throw new ZoteroApiError(`\u65E0\u6CD5\u8FDE\u63A5 Zotero \u672C\u5730 API\uFF08${this.baseUrl}\uFF09\u3002\u8BF7\u786E\u8BA4 Zotero \u6B63\u5728\u8FD0\u884C\uFF0C\u4E14\u5DF2\u5F00\u542F\u300C\u8BBE\u7F6E \u2192 \u9AD8\u7EA7 \u2192 \u5141\u8BB8\u5176\u4ED6\u5E94\u7528\u7A0B\u5E8F\u4E0E\u6B64\u8BA1\u7B97\u673A\u4E0A\u7684 Zotero \u901A\u4FE1\u300D\u3002`, "offline");
    }
    this.recordHeaders(res);
    if (res.status === 403)
      throw new ZoteroApiError("Zotero \u62D2\u7EDD\u4E86\u8BF7\u6C42\uFF08403\uFF09\uFF0C\u8BF7\u5728\u6388\u6743\u5F39\u7A97\u4E2D\u70B9\u51FB\u5141\u8BB8\u3002", "api-disabled", 403);
    if (res.status === 401 && opts.write) {
      if (this.autoAuthorize && opts.retryAuth !== false) {
        await this.authorize(this.appName);
        return this.request(method, path, { ...opts, retryAuth: false });
      }
      throw new ZoteroApiError("\u5199\u8BF7\u6C42\u672A\u6388\u6743\uFF08401\uFF09\uFF0C\u8BF7\u5148\u8FD0\u884C zotero-auth \u83B7\u53D6 key\u3002", "needs-auth", 401);
    }
    if (res.status === 412)
      throw new ZoteroApiError("\u6570\u636E\u5DF2\u88AB\u5176\u4ED6\u64CD\u4F5C\u4FEE\u6539\uFF08\u7248\u672C\u51B2\u7A81 412\uFF09\uFF0C\u8BF7\u91CD\u8BD5\u3002", "conflict", 412);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ZoteroApiError(`Zotero API HTTP ${res.status}: ${detail.slice(0, 200)}`, "http", res.status);
    }
    if (opts.raw)
      return res;
    if (res.status === 204)
      return null;
    return res.json();
  }
  get(path) {
    return this.request("GET", path);
  }
  post(path, body, opts) {
    return this.request("POST", path, { ...opts, body });
  }
  patch(path, body, opts) {
    return this.request("PATCH", path, { ...opts, body });
  }
  // ---------------------------------------------------------------------------
  // 状态与授权
  // ---------------------------------------------------------------------------
  /** 探测连接；同时从响应头学习 Server-ID 与版本。 */
  async ping() {
    const res = await this.request("GET", "/", { raw: true });
    await res.text();
    return { serverId: this.serverId, zoteroVersion: this.zoteroVersion };
  }
  /** 写入能力（Zotero 10+ 才支持本地 API 写入）。 */
  async canWrite() {
    await this.ping();
    const major = parseInt(this.zoteroVersion.split(".")[0] ?? "0", 10);
    return major >= MIN_WRITE_MAJOR_VERSION;
  }
  /**
   * 弹窗请求用户授权写入。remember=true（用户选「始终允许」）时 Zotero 持久化该 key，
   * 可跨进程复用；remember=false 为单次 key，一个写请求后即被消耗。
   */
  async authorize(appName = "literature-search-agent") {
    if (!this.serverId)
      await this.ping();
    const doFetch = () => this.fetchImpl(`${this.baseUrl}/local/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Connection: "close",
        // 防止 undici 复用 Zotero HTTP/1.0 已关闭的 socket
        ...this.serverId ? { "Zotero-Server-ID": this.serverId } : {}
      },
      body: JSON.stringify({ appName })
    });
    const res = await doFetch().catch(() => doFetch()).catch((error) => {
      throw new ZoteroApiError(`\u65E0\u6CD5\u8FDE\u63A5 Zotero \u8FDB\u884C\u6388\u6743\uFF08${error instanceof Error ? error.message : String(error)}\uFF09`, "offline");
    });
    this.recordHeaders(res);
    if (res.status === 403)
      throw new ZoteroApiError("\u7528\u6237\u62D2\u7EDD\u4E86\u5199\u5165\u6388\u6743\u3002", "denied", 403);
    if (!res.ok)
      throw new ZoteroApiError(`\u6388\u6743\u5931\u8D25\uFF08HTTP ${res.status}\uFF09\u3002\u5199\u5165\u9700\u8981 Zotero ${MIN_WRITE_MAJOR_VERSION}+\u3002`, "version", res.status);
    const data = record6(await res.json());
    if (typeof data.key !== "string" || !data.key)
      throw new ZoteroApiError("\u6388\u6743\u54CD\u5E94\u7F3A\u5C11 key\u3002", "http");
    this.apiKey = data.key;
    return { key: data.key, remember: data.remember === true };
  }
  // ---------------------------------------------------------------------------
  // 读取
  // ---------------------------------------------------------------------------
  /**
   * 关键词检索（本地 quicksearch，排除附件/笔记/批注）。读免认证。
   * qmode 默认 titleCreatorYear；查 DOI 等全字段需 'everything'。
   */
  async searchItems(query, options = {}) {
    const limit = options.limit ?? 20;
    const prefix = libraryPrefix(options.libraryKey);
    const qmode = options.qmode ? `&qmode=${options.qmode}` : "";
    const value = await this.get(`${prefix}/items?q=${encodeURIComponent(query)}${qmode}&itemType=-attachment%20%7C%7C%20note%20%7C%7C%20annotation&limit=${limit}`);
    return (Array.isArray(value) ? value : []).map((entry) => {
      const item = record6(entry);
      const data = record6(item.data);
      return {
        key: typeof item.key === "string" ? item.key : "",
        libraryKey: options.libraryKey ?? "user",
        itemType: typeof data.itemType === "string" ? data.itemType : "",
        title: typeof data.title === "string" ? data.title : "",
        authors: creatorsToAuthors(data.creators),
        year: extractYear(data.date),
        doi: typeof data.DOI === "string" ? normalizeDoi(data.DOI) : "",
        url: typeof data.url === "string" ? data.url : ""
      };
    }).filter((item) => item.key);
  }
  /** DOI 查重：全字段 quicksearch（qmode=everything，默认 titleCreatorYear 不含 DOI）后按归一化 DOI 精确匹配。 */
  async findByDoi(doi, options = {}) {
    const normalized = normalizeDoi(doi);
    if (!normalized)
      return void 0;
    const candidates = await this.searchItems(normalized, { limit: 25, qmode: "everything", ...options.libraryKey ? { libraryKey: options.libraryKey } : {} });
    return candidates.find((item) => item.doi === normalized);
  }
  // ---------------------------------------------------------------------------
  // 写入（Zotero 10+，需授权 key）
  // ---------------------------------------------------------------------------
  /** 创建条目，返回新条目 key。 */
  async createItem(options) {
    const data = {
      itemType: options.itemType ?? "journalArticle",
      ...options.fields,
      creators: (options.creators ?? []).map((c) => ({ creatorType: "author", ...c })),
      tags: [],
      collections: options.collectionKey ? [options.collectionKey] : []
    };
    const res = record6(await this.post(`${libraryPrefix(options.libraryKey)}/items`, [data], { write: true }));
    const successful = record6(res.successful);
    const first = record6(successful["0"]);
    if (typeof first.key !== "string" || !first.key) {
      const failed = record6(record6(res.failed)["0"]);
      throw new ZoteroApiError(`\u521B\u5EFA\u6761\u76EE\u5931\u8D25: ${typeof failed.message === "string" ? failed.message : JSON.stringify(res).slice(0, 200)}`, "http");
    }
    return { itemKey: first.key };
  }
  /** 在条目下创建子笔记。 */
  async createNote(parentItemKey, content, options = {}) {
    const res = record6(await this.post(`${libraryPrefix(options.libraryKey)}/items`, [{
      itemType: "note",
      parentItem: parentItemKey,
      note: content,
      tags: []
    }], { write: true }));
    const key = record6(record6(res.successful)["0"]).key;
    if (typeof key !== "string" || !key)
      throw new ZoteroApiError("\u521B\u5EFA\u7B14\u8BB0\u5931\u8D25\u3002", "http");
    return { noteKey: key };
  }
  /** 加入收藏夹（读当前 collections 取并集，If-Unmodified-Since-Version 乐观锁）。 */
  async addToCollection(itemKey, collectionKey, options = {}) {
    const prefix = libraryPrefix(options.libraryKey);
    const current = record6(await this.get(`${prefix}/items/${encodeURIComponent(itemKey)}`));
    const data = record6(current.data);
    const existing = new Set(Array.isArray(data.collections) ? data.collections : []);
    existing.add(collectionKey);
    await this.patch(`${prefix}/items/${encodeURIComponent(itemKey)}`, { collections: [...existing] }, {
      write: true,
      headers: { "If-Unmodified-Since-Version": String(current.version ?? 0) }
    });
  }
  /**
   * 上传 PDF 附件（四段流程，移植 Read-Studio importPdfAttachment）：
   *  1. 创建 attachment 子条目（md5/mtime 置空）
   *  2. 请求上传授权（If-None-Match: *；同文件已存在则 auth.exists → 跳过上传）
   *  3. 直传文件内容（auth.url 优先，否则 PUT 到 /file）
   *  4. 带 uploadKey 时注册上传完成
   */
  async uploadPdfAttachment(filePath, parentItemKey, options = {}) {
    const prefix = libraryPrefix(options.libraryKey);
    const [fileBytes, fileStat] = await Promise.all([readFile2(filePath), stat(filePath)]);
    const filename = basename(filePath);
    const md5 = createHash("md5").update(fileBytes).digest("hex");
    const mtime = Math.round(fileStat.mtimeMs);
    const created = record6(await this.post(`${prefix}/items`, [{
      itemType: "attachment",
      linkMode: "imported_file",
      parentItem: parentItemKey,
      title: options.title ?? filename.replace(/\.pdf$/i, ""),
      contentType: "application/pdf",
      filename,
      md5: null,
      mtime: null
    }], { write: true }));
    const attachKey = record6(record6(created.successful)["0"]).key;
    if (typeof attachKey !== "string" || !attachKey) {
      throw new ZoteroApiError(`\u521B\u5EFA\u9644\u4EF6\u6761\u76EE\u5931\u8D25: ${JSON.stringify(created).slice(0, 200)}`, "http");
    }
    const authRes = await this.request("POST", `${prefix}/items/${attachKey}/file`, {
      write: true,
      raw: true,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "If-None-Match": "*" },
      body: new URLSearchParams({ md5, filename, filesize: String(fileBytes.byteLength), mtime: String(mtime) }).toString()
    });
    const auth = record6(await authRes.json());
    if (auth.exists)
      return { attachmentKey: attachKey, duplicate: true };
    const uploadUrl = typeof auth.url === "string" && auth.url ? auth.url.startsWith("http") ? auth.url : `${this.baseUrl}${auth.url}` : `${this.baseUrl}${prefix}/items/${attachKey}/file`;
    const upRes = await this.fetchImpl(uploadUrl, {
      method: typeof auth.url === "string" && auth.url ? "POST" : "PUT",
      headers: { "Content-Type": "application/pdf", "Content-Length": String(fileBytes.byteLength), Connection: "close" },
      body: fileBytes
    });
    if (!upRes.ok && upRes.status !== 201 && upRes.status !== 204) {
      const detail = await upRes.text().catch(() => "");
      throw new ZoteroApiError(`PDF \u4E0A\u4F20\u5931\u8D25\uFF08HTTP ${upRes.status}\uFF09: ${detail.slice(0, 200)}`, "http", upRes.status);
    }
    if (typeof auth.uploadKey === "string" && auth.uploadKey) {
      await this.request("POST", `${prefix}/items/${attachKey}/file`, {
        write: true,
        raw: true,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `upload=${encodeURIComponent(auth.uploadKey)}`
      });
    }
    return { attachmentKey: attachKey, duplicate: false };
  }
  /** 删除条目（进回收站；If-Unmodified-Since-Version 乐观锁）。主要供测试清理。 */
  async deleteItem(itemKey, options = {}) {
    const prefix = libraryPrefix(options.libraryKey);
    const current = record6(await this.get(`${prefix}/items/${encodeURIComponent(itemKey)}`));
    await this.request("DELETE", `${prefix}/items/${encodeURIComponent(itemKey)}`, {
      write: true,
      raw: true,
      headers: { "If-Unmodified-Since-Version": String(current.version ?? 0) }
    });
  }
};
function libraryPrefix(libraryKey) {
  if (!libraryKey || libraryKey === "user")
    return "/users/0";
  if (libraryKey.startsWith("group:"))
    return `/groups/${encodeURIComponent(libraryKey.slice(6))}`;
  return "/users/0";
}

// dist/core/zotero/save.js
function splitAuthorName(fullName) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0)
    return {};
  if (parts.length === 1)
    return { name: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}
function itemTypeFor(work) {
  return work.externalIds.arxiv ? "preprint" : "journalArticle";
}
function workToZoteroFields(work) {
  const fields = { title: work.title };
  if (work.year)
    fields.date = String(work.year);
  if (work.venue) {
    if (work.externalIds.arxiv)
      fields.repository = work.venue || "arXiv";
    else
      fields.publicationTitle = work.venue;
  }
  if (work.doi)
    fields.DOI = work.doi;
  if (work.url)
    fields.url = work.url;
  if (work.abstract)
    fields.abstractNote = work.abstract;
  const extra = [];
  if (work.citationCount !== null)
    extra.push(`Citations (${work.source}): ${work.citationCount}`);
  if (work.externalIds.openalex)
    extra.push(`OpenAlex: ${work.externalIds.openalex}`);
  if (extra.length)
    fields.extra = extra.join("\n");
  return fields;
}
async function saveWork(client, request, options = {}) {
  const { item, pdfPath, collectionKey, note } = request;
  if (item.doi) {
    const existing = await client.findByDoi(item.doi, { ...options.libraryKey ? { libraryKey: options.libraryKey } : {} });
    if (existing) {
      if (pdfPath) {
        const attachment = await client.uploadPdfAttachment(pdfPath, existing.key, {
          title: item.title,
          ...options.libraryKey ? { libraryKey: options.libraryKey } : {}
        });
        return { outcome: attachment.duplicate ? "exists" : "attached", itemKey: existing.key, attachmentKey: attachment.attachmentKey };
      }
      return { outcome: "exists", itemKey: existing.key };
    }
  }
  const { itemKey } = await client.createItem({
    itemType: itemTypeFor(item),
    fields: workToZoteroFields(item),
    creators: item.authors.map(splitAuthorName),
    ...collectionKey ? { collectionKey } : {},
    ...options.libraryKey ? { libraryKey: options.libraryKey } : {}
  });
  let attachmentKey;
  if (pdfPath) {
    const attachment = await client.uploadPdfAttachment(pdfPath, itemKey, {
      title: item.title,
      ...options.libraryKey ? { libraryKey: options.libraryKey } : {}
    });
    attachmentKey = attachment.attachmentKey;
  }
  if (note) {
    await client.createNote(itemKey, note, { ...options.libraryKey ? { libraryKey: options.libraryKey } : {} });
  }
  return { outcome: "created", itemKey, ...attachmentKey ? { attachmentKey } : {} };
}
export {
  MIN_WRITE_MAJOR_VERSION,
  ProviderError,
  RateLimiter,
  ZoteroApiError,
  ZoteroClient,
  arxivAbstract,
  citedByOpenAlex,
  cleanCrossrefAbstract,
  dedupeWorks,
  discoverOaPdfUrl,
  downloadPdf,
  enrichAbstract,
  europePmcAbstract,
  extractDoi,
  extractPdfText,
  foldForMatch,
  htmlAbstract,
  invertOpenAlexAbstract,
  itemTypeFor,
  lookupCrossrefByDoi,
  lookupOpenAlexByDoi,
  lookupS2ByDoi,
  lookupUnpaywall,
  mapCrossrefWork,
  mapOpenAlexWork,
  mapS2Paper,
  normalizeDoi,
  openAccessHtmlAbstract,
  requestJson,
  requestText,
  safeOpenAccessUrl,
  saveWork,
  searchCrossref,
  searchOpenAlex,
  searchSemanticScholar,
  splitAuthorName,
  streamPdfToFile,
  titlesAlign,
  workToZoteroFields
};
