# PITFALL — DSH preset / 插件开发踩坑记录

> 来源：literature-search-agent 阶段4 preset + 4b 插件 + 自家 `dsh-multi-reviewer`
> 插件实战（2026-09）。每条都附实际失败证据，供后续会话与架构审查避坑。

## preset 安装与同步

1. **源与运行副本双份漂移**：项目里 `interfaces/dsh-preset/` 是源，
   `~/.dsh/.agent-presets/<id>/` 是**运行副本**。改源不同步 → 跑的永远是旧版
   （行为层错误的最大来源）。同步流程：复制三件套 → `node --input-type=module --check`
   → `agentPresets.standingKeyFor(id)` 校验 → 新开会话。
2. **junction / 符号链接不可行**：DSH 的 preset 发现逻辑**排除 reparse point 目录**
   （对照实验：真实目录被发现、指向它的 junction 被丢弃，roster 只列
   standard/ptc/minimal/cordis）。不能靠 junction 消灭双份漂移。
3. **preset 挂载校验 vs roster**：`agentPresets.list()` 的 `broken` 字段只是形状检查；
   真实校验 = `standingKeyFor(id)`（包解析失败 / 配置不合法 / 行未激活 /
   进程全局服务冲突，四类失败都会在这里暴露）。
4. **`agentPresets.copy(from, id, name)`**：整目录复制（含 skills/）+ 重写 preset.yml
   （保留 description、丢 name/order）；复制后需自己补 description。

## dsh-persona 配置

5. **dsh-persona 只认 `config.prefix` / `config.suffix`**：schema 为
   `z.object({ prefix: z.string().required(), suffix: z.string().default("") })`；
   **`config.text` 不合法** → 挂载失败 `$.prefix missing required value`。
   其实现是 `text: config.prefix`（text 是输出键，不是输入键）。旧版本 schema 较宽容，
   曾掩盖过这个 bug；组件换新版本后立刻暴露。

## core 插件与 preset 冲突

6. **tool-cordis（创造模式的自省工具集）是进程级单例**：其 Inspect provider
   （`Service` 等）同一进程只能注册一次。两个都带 tool-cordis 的 preset 无法共存，
   第二个挂载报 `Host Cordis inspect provider "Service" is already registered`。
   **基于 cordis 复制新 preset 必须删除 tool-cordis 行**（保留其余基底）。
7. **profile 层 `cordis.patch.yml`（bundle patch）生效需重启 DSH**；
   `disabled: true` 会**连 client 半一起禁**（不只是 host 工具/路由）——曾因此把
   多审稿人的「论文审稿」中栏 tab 全删掉。

## client UI（全局平面）与会话门控

8. **client UI 是全局平面**：slots 注册（如 `conversation.view`）由 profile/client
   插件加载，preset 行只能带 host 工具。想「UI 只在某 preset 出现」必须 client 侧
   按会话判断。
9. **`conversation.view` 的 tab 列表 = 注册条目的投影，不看 render**：DSH 源码
   `viewTabs()` 直接遍历 `slots.entries("conversation.view")` 取 id/label
   （`dsh-client-ui-conversation/lib/client.js`）。**render 返回 null 藏不住 tab**；
   必须按会话动态 register / unregister 条目本身（register 返回 disposer）。
10. **host 拿「当前会话」的身份很难**：webServer route handler 与 package-private
    RPC 都没有会话上下文。可靠做法：client 传 `sessionId`，host 监听官方事件
    `agent-preset/selected (sessionId, agentPreset)` 建映射，或读 session 记录头字段
    `agentPreset`。
11. **同一插件的 profile 行 + preset 行并存 → 路由撞车**：挂载失败
    `webserver: duplicate exact route "/multi-reviewer/api/settings"`。解法：profile 行
    `config: { uiOnly: true }`（host apply 跳过业务路由与工具、只留门控路由），
    preset 行全量注册，两行路由零重叠。**行配置传参 = `apply(ctx, config)` 第二参**
    （cordis 框架标准；`dsh-tool-fs` 同款）。

## 分发与打包

12. **core 入口的机器特定路径**：host-plugin.js 默认
    `file:///D:/…/dist/core/index.js`；分发用 `LIT_SEARCH_CORE_URL` 环境变量覆盖
    （绝对路径或 file:// URL 均可）。
13. **esbuild 打 core 单文件必须惰性化 pdf-parse**：静态
    `import { PDFParse } from "pdf-parse"` 会让缺依赖的机器**整个 bundle 加载失败**
    （不只是提取功能）；改成函数内 `await import("pdf-parse")`。注意：**每次 esbuild
    重建 bundle 都会把静态 import 带回来**，补丁要固化进构建脚本。
14. **client bundle 伺服**：本环境（pnpm link 插件、无构建产物）client 半是从
    **链接源实时伺服**的，重启页面即生效；若「改了没生效」，先查是否存在构建缓存/
    产物（clientModules 有 artifactBaseline/rebuilt 机制）。

## 其他

15. **lit-research 安装目录曾被整体删除**——源在仓库 `interfaces/dsh-preset/`，
    重建三件套即可恢复；再次印证「仓库是唯一事实来源」。
16. **参数 DSL 必须预编译**：`ctx.tools.register` 收的是已编译 schema，参数 DSL 要先经
    `parameterSchemaSpecToJsonSchema` 等价编译（compileParams），否则模型 API 校验
    失败（详见 `docs/PITFALL-dsh-preset-tool-params-stripped.md`）。