/**
 * dsh-literature-search — Client 半（浏览器）。
 * 手写 dsh 客户端模块系统的 lazy-CJS factory 格式（与 tsdown 产物同构）：
 * 执行本 bundle 只注册 factory；首次物化时才运行模块体。
 * 共享模块（react 等）由外壳静态模块表提供，经 factory 的 require 注入。
 *
 * UI：sidebar.footer.action 入口按钮 + shell.overlay 浮动面板，
 * 检索走 Host 半注册的 /lit-search/api/search（同源 fetch）。
 */
window.__ModuleLoader__.load({
  id: "dsh-literature-search",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");

    var CSS = [
      "[data-shell-overlay] { z-index: 2000 !important; }",
      ".ls-entry { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; text-align: left; }",
      ".ls-entry:hover { border-color: var(--dsw-alias-border-l2); }",
      ".ls-entry-active { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); border-color: var(--dsw-alias-brand-primary); }",
      ".ls-pill { position: fixed; right: 16px; bottom: 16px; z-index: 70; padding: 8px 14px; border: none; border-radius: 999px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 13px; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.25); pointer-events: auto; }",
      ".ls-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 420px; max-width: 92vw; z-index: 60; display: flex; flex-direction: column; background: var(--dsw-alias-bg-overlay); border-left: 1px solid var(--dsw-alias-border-l1); box-shadow: -8px 0 24px rgba(0,0,0,0.18); pointer-events: auto; font-size: 13px; color: var(--dsw-alias-label-primary); }",
      ".ls-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }",
      ".ls-title { font-weight: 600; }",
      ".ls-close { border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 16px; cursor: pointer; padding: 2px 6px; }",
      ".ls-close:hover { color: var(--dsw-alias-label-primary); }",
      ".ls-searchrow { display: flex; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }",
      ".ls-input { flex: 1; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; outline: none; }",
      ".ls-input:focus { border-color: var(--dsw-alias-brand-primary); }",
      ".ls-go { padding: 6px 14px; border: none; border-radius: 8px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 13px; cursor: pointer; }",
      ".ls-go:disabled { opacity: 0.5; cursor: default; }",
      ".ls-body { flex: 1; overflow-y: auto; padding: 10px 14px; }",
      ".ls-status { color: var(--dsw-alias-label-secondary); padding: 8px 2px; }",
      ".ls-error { color: var(--dsw-alias-state-error-primary); padding: 8px 2px; white-space: pre-wrap; }",
      ".ls-warn { color: var(--dsw-alias-state-warn-primary); padding: 4px 2px 8px; font-size: 12px; }",
      ".ls-item { padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }",
      ".ls-item-title { display: block; color: var(--dsw-alias-label-primary); font-weight: 600; text-decoration: none; line-height: 1.4; }",
      ".ls-item-title:hover { color: var(--dsw-alias-brand-primary); text-decoration: underline; }",
      ".ls-item-meta { margin-top: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }",
      ".ls-badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 6px; font-size: 11px; background: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-bg-base); }",
      ".ls-foot { padding: 8px 14px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 11px; }",
      ".ls-ab { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; }",
      ".ls-ab-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }",
      ".ls-ab-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }",
      ".ls-ab-h { margin: 6px 0 2px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }",
      ".ls-ab-p { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.7; }",
      ".ls-ab-cards { display: flex; flex-direction: column; gap: 6px; }",
      ".ls-ab-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; background: var(--dsw-alias-fill-l1); }",
      ".ls-ab-name { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); font-family: Consolas, 'Cascadia Mono', monospace; }",
      ".ls-ab-desc { margin-top: 3px; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }",
      ".ls-ab-params { margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-family: Consolas, 'Cascadia Mono', monospace; }",
      ".ls-ab-env { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-family: Consolas, 'Cascadia Mono', monospace; }",
      ".ls-ab-a { color: var(--dsw-alias-brand-primary); text-decoration: none; }",
    ].join("\n");

    function apply(ctx) {
      var slots = ctx.get("slots");
      if (slots === undefined) {
        console.warn("[dsh-literature-search] slots service unavailable; plugin idle");
        return;
      }

      // 包内样式，随 fiber 卸载移除
      var styleEl = document.createElement("style");
      styleEl.dataset.dshLiteratureSearch = "";
      styleEl.textContent = CSS;
      document.head.appendChild(styleEl);
      ctx.effect(() => () => styleEl.remove(), "dsh-literature-search: styles");

      // 两个 Slot 共享的开关状态
      var listeners = new Set();
      var store = {
        open: false,
        toggle: function () {
          store.open = !store.open;
          listeners.forEach(function (l) { l(store.open); });
        },
        subscribe: function (l) {
          listeners.add(l);
          return function () { listeners.delete(l); };
        },
      };
      function useOpen() {
        var pair = React.useState(store.open);
        React.useEffect(function () { return store.subscribe(pair[1]); }, []);
        return pair[0];
      }

      function FooterButton() {
        var open = useOpen();
        return React.createElement(
          "button",
          {
            className: "ls-entry" + (open ? " ls-entry-active" : ""),
            title: "文献检索",
            onClick: function () { store.toggle(); },
          },
          "📚 文献检索",
        );
      }

      function WorkItemView(props) {
        var w = props.item;
        var href = w.doi ? "https://doi.org/" + w.doi : w.url || undefined;
        var meta = [
          w.authors.join(", ") + (w.authorsTotal > w.authors.length ? " 等" : ""),
          [w.year, w.venue].filter(Boolean).join(" · "),
          w.citationCount !== null ? "被引 " + w.citationCount : null,
        ].filter(Boolean);
        return React.createElement(
          "div",
          { className: "ls-item" },
          React.createElement(
            "a",
            { className: "ls-item-title", href: href, target: "_blank", rel: "noreferrer" },
            w.title,
            w.oaPdfUrl ? React.createElement("span", { className: "ls-badge" }, "OA PDF") : null,
          ),
          React.createElement("div", { className: "ls-item-meta" }, meta.join(" — ")),
        );
      }

      function Panel() {
        var open = useOpen();
        var queryPair = React.useState("");
        var query = queryPair[0];
        var setQuery = queryPair[1];
        var statePair = React.useState({ status: "idle" });
        var state = statePair[0];
        var setState = statePair[1];
        if (!open) return null;

        var runSearch = function () {
          var q = query.trim();
          if (!q || state.status === "loading") return;
          setState({ status: "loading" });
          fetch("/lit-search/api/search?q=" + encodeURIComponent(q) + "&limit=10")
            .then(function (r) { return r.json(); })
            .then(function (res) {
              if (res && res.ok && Array.isArray(res.items)) {
                var oa = res.diagnostics && res.diagnostics.openalex;
                setState({
                  status: "done",
                  items: res.items,
                  sourceError: oa && oa.error ? String(oa.error) : null,
                });
              } else {
                setState({ status: "error", error: (res && res.error) || "未知错误" });
              }
            })
            .catch(function (err) { setState({ status: "error", error: String(err) }); });
        };

        var body;
        if (state.status === "idle") {
          body = React.createElement("div", { className: "ls-status" }, "输入关键词，进程内调用 literature-search-agent core 检索 OpenAlex（含去重与节流）。");
        } else if (state.status === "loading") {
          body = React.createElement("div", { className: "ls-status" }, "检索中……");
        } else if (state.status === "error") {
          body = React.createElement("div", { className: "ls-error" }, "检索失败：" + state.error);
        } else {
          var children = [];
          if (state.sourceError) children.push(React.createElement("div", { key: "w", className: "ls-warn" }, "来源告警：" + state.sourceError));
          if (state.items.length === 0) {
            children.push(React.createElement("div", { key: "e", className: "ls-status" }, "无结果。"));
          } else {
            children.push(React.createElement("div", { key: "c", className: "ls-status" }, "命中 " + state.items.length + " 条（去重后）"));
            state.items.forEach(function (w, i) { children.push(React.createElement(WorkItemView, { key: i, item: w })); });
          }
          body = React.createElement(React.Fragment, null, children);
        }

        return React.createElement(
          "div",
          { className: "ls-panel" },
          React.createElement(
            "div",
            { className: "ls-head" },
            React.createElement("span", { className: "ls-title" }, "📚 文献检索"),
            React.createElement("button", { className: "ls-close", title: "关闭", onClick: function () { store.toggle(); } }, "✕"),
          ),
          React.createElement(
            "div",
            { className: "ls-searchrow" },
            React.createElement("input", {
              className: "ls-input",
              placeholder: "例如：plasma channel ion acceleration",
              value: query,
              onChange: function (e) { setQuery(e.target.value); },
              onKeyDown: function (e) { if (e.key === "Enter") runSearch(); },
            }),
            React.createElement("button", { className: "ls-go", disabled: state.status === "loading", onClick: runSearch }, "检索"),
          ),
          React.createElement("div", { className: "ls-body" }, body),
          React.createElement("div", { className: "ls-foot" }, "dsh-literature-search · literature-search-agent core（OpenAlex）"),
        );
      }

      function OverlayEntry() {
        var open = useOpen();
        return React.createElement(
          React.Fragment,
          null,
          React.createElement("button", { className: "ls-pill", onClick: function () { store.toggle(); } }, open ? "📚 收起" : "📚 文献检索"),
          React.createElement(Panel),
        );
      }

      // ── 说明页数据（设置页「文献调研助手 · 说明」）──────────────────────
      var TOOLS = [
        { n: "lit_search", d: "多源学术检索（OpenAlex / Semantic Scholar / Crossref），支持关键词、年份范围、条数控制，结果自动去重。", p: "query · source · limit · yearFrom · yearTo" },
        { n: "lit_abstract", d: "摘要富集：DOI 或标题 → 多源兜底链（OpenAlex → Crossref → S2 → EuropePMC → arXiv → OA HTML → Unpaywall）。", p: "doi · title" },
        { n: "lit_cited_by", d: "查询一篇文献的被引列表（OpenAlex cited-by），用于扩展研究路线。", p: "identifier（DOI 或 W…ID）· limit" },
        { n: "lit_download_pdf", d: "发现 OA PDF 链接并下载到本地（自动校验 %PDF 魔数、30MB 上限）。", p: "doi · oaPdfUrl · outPath" },
        { n: "pdf_extract_text", d: "从本地 PDF 提取全文文本（页数/字符数截断，防上下文爆炸）。", p: "pdfPath · maxPages · maxChars" },
        { n: "zotero_search", d: "检索本地 Zotero 库（只读、免认证；需 Zotero 10+ 运行中）。", p: "query · limit · qmode" },
        { n: "zotero_save", d: "一键归档：DOI 查重 → 建条目 → 挂 PDF → 收藏夹 → 笔记（幂等，不重复建条目）。", p: "doi · title · pdfPath · collectionKey · note" },
      ];
      var ENVS = [
        "LIT_SEARCH_MAILTO — OpenAlex / Crossref / Unpaywall polite pool 邮箱",
        "LIT_SEARCH_OPENALEX_API_KEY — OpenAlex 账户额度（无则回落 mailto 池 / 匿名池）",
        "LIT_SEARCH_S2_API_KEY — Semantic Scholar 独享配额（无 key 匿名池 429 频发）",
        "LIT_SEARCH_ZOTERO_KEY / LIT_SEARCH_ZOTERO_URL — Zotero 持久写 key 与本地 API 地址",
        "LIT_SEARCH_CORE_URL — 核心库入口（默认本机 dist/core/index.js，分发时必设）",
      ];

      function AboutPage() {
        var children = [
          React.createElement("div", { key: "title", className: "ls-ab-title" }, "文献调研助手（lit-research）"),
          React.createElement("div", { key: "sub", className: "ls-ab-sub" }, "基于 literature-search-agent core 的学术文献调研 Agent：多源检索、摘要富集、引用拓展、OA PDF 与全文提取、Zotero 归档。证据优先、严格防幻觉。"),
          React.createElement("div", { key: "h1", className: "ls-ab-h" }, "可用工具（7 个模型工具）"),
          React.createElement("div", { key: "tools", className: "ls-ab-cards" }, TOOLS.map(function (t) {
            return React.createElement("div", { key: t.n, className: "ls-ab-card" },
              React.createElement("div", { className: "ls-ab-name" }, t.n),
              React.createElement("div", { className: "ls-ab-desc" }, t.d),
              React.createElement("div", { className: "ls-ab-params" }, "参数：", t.p));
          })),
          React.createElement("div", { key: "h2", className: "ls-ab-h" }, "基础能力（标准工具）"),
          React.createElement("div", { key: "std", className: "ls-ab-p" }, "文件读写与搜索（fs）、向用户提问（ask_user_question）、任务清单（todo）、终端（pwsh / bash）。"),
          React.createElement("div", { key: "h3", className: "ls-ab-h" }, "核心原则"),
          React.createElement("div", { key: "pr", className: "ls-ab-p" }, "证据优先级：直接证据 > 有限推论 > 综合判断 > 未知。禁止虚构论文信息、禁止按标题猜内容、禁止用领域常识补论文参数、禁止伪造引用；工具失败时如实报告原因并引导修复，不绕过工具。"),
          React.createElement("div", { key: "h4", className: "ls-ab-h" }, "典型流程"),
          React.createElement("div", { key: "flow", className: "ls-ab-p" }, "明确问题 → lit_search 多查询检索 → DOI 去重 → 初筛 → lit_abstract 摘要验证 → lit_cited_by 引用扩展 → lit_download_pdf + pdf_extract_text 精读 → 交叉验证 → 综述 → zotero_save 归档。"),
          React.createElement("div", { key: "h5", className: "ls-ab-h" }, "环境变量"),
          React.createElement("div", { key: "env", className: "ls-ab-cards" }, ENVS.map(function (e) {
            return React.createElement("div", { key: e, className: "ls-ab-env" }, e);
          })),
          React.createElement("div", { key: "h6", className: "ls-ab-h" }, "相关链接"),
          React.createElement("div", { key: "links", className: "ls-ab-p" },
            React.createElement("a", { key: "gh", className: "ls-ab-a", href: "https://github.com/wjma-phy/literature-search-agent", target: "_blank", rel: "noreferrer" }, "GitHub 仓库"),
            " · ",
            React.createElement("a", { key: "plan", className: "ls-ab-a", href: "https://github.com/wjma-phy/literature-search-agent/blob/main/docs/PLAN.md", target: "_blank", rel: "noreferrer" }, "实施计划")),
        ];
        return React.createElement("div", { className: "ls-ab" }, children);
      }

      slots.inject("sidebar.footer.action", function () {
        return slots.register(
          { name: "sidebar.footer.action", id: "lit-search", order: 10, label: "文献检索" },
          function () { return React.createElement(FooterButton); },
        );
      });
      slots.inject("shell.overlay", function () {
        return slots.register(
          { name: "shell.overlay", id: "lit-search-panel", order: 30, label: "文献检索面板" },
          function () { return React.createElement(OverlayEntry); },
        );
      });
      slots.inject("settings.section", function () {
        return slots.register(
          { name: "settings.section", id: "lit-about", order: 35, label: "文献调研助手 · 说明" },
          function () { return React.createElement(AboutPage); },
        );
      });
    }

    exports.apply = apply;
    return module.exports;
  },
});
