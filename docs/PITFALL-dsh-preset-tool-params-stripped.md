# 踩坑记录：DSH preset 工具参数被静默剥离

> 2026-09-12 会话实测定位。症状极具误导性，特此记录。

## 现象

preset「文献调研助手」的全部 7 个工具（lit_search / lit_abstract / lit_cited_by /
lit_download_pdf / pdf_extract_text / zotero_search / zotero_save）在模型侧注册为：

```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

——没有任何参数声明。后果：

- 模型显式传入的 `query` 等参数在派发前被 harness 按 schema **静默剥离**；
- 工具收到 `args.query === undefined`；
- `zotero_search` 渲染出误导性消息「Zotero 中未找到「undefined」相关条目」——
  看起来像"库中没有文献"，实际是参数根本没传到工具。

## 根因

`interfaces/dsh-preset/host-plugin.js` 旧版把参数 DSL 原样传给 `ctx.tools.register()`：

```js
parameters: { query: { type: 'string', required: true } }  // ❌ 原样 DSL
```

但 `register()` 接收的是**已编译**的 ToolDefinition——它只校验 output，不再编译
parameters（编译是 dsh-tools `defineTool()` / `parameterSchemaSpecToJsonSchema()`
的职责）。原样 DSL 导致模型侧 schema 为空。

**修复**：host-plugin.js 新增 `compileParams()`，复刻
`parameterSchemaSpecToJsonSchema()` 的行为——属性表 →
`{ type:'object', properties, required? }`，把各属性的 `required: true` 收集到根
`required` 数组，参数根保持开放（不写 `additionalProperties`）：

```js
parameters: compileParams(def.parameters)  // ✅ 先编译再注册
```

## 关键教训：改了插件没生效 ≠ 修复无效

DSH 宿主进程**只在启动时加载** cordis 插件（含 preset 的 host-plugin.js），
**无热更新**。本次修复写入时间（17:08:50）比宿主进程启动时间（17:07:01）晚约
2 分钟，旧行为持续了整个会话，直到重启宿主后才生效。

排查三板斧——对比三个时间戳：

1. 宿主进程 StartTime（`Get-Process node | Select StartTime`）
2. 已安装 preset 副本 mtime（`~/.dsh/.agent-presets/<preset>/host-plugin.js`）
3. 工作区源文件 mtime（`interfaces/dsh-preset/host-plugin.js`）

注意：已安装副本（`~/.dsh/.agent-presets/lit-research/`）与工作区源
（`interfaces/dsh-preset/`）是**两份独立文件**，改工作区后需重新安装/同步，
再重启宿主。

## 附：zotero_search 实测行为（修复后验证）

- 查询透传给 Zotero 本地 quicksearch（`GET /users/0/items?q=...`，
  `core/zotero/client.ts` 的 `searchItems()`），默认 `qmode=titleCreatorYear`。
- 语义：**空格分词 + 逐词 AND + 子串匹配**，只查标题/作者/年份；
  无 OR、无同义词扩展、不查摘要/标签/全文。
  - 多词堆叠易归零：`heavy ion acceleration laser` → 0 条
    （`acceleration` 一词缺席即排除全部候选）；
  - 短词有子串噪音：`ion` 会命中 "injection"、"ionization"；
  - 中文整串查询对英文库必然为 0（整串作为一个子串匹配英文标题）。
- 检索建议：用短而精准的核心英文词组（如 `ion acceleration`，实测 20 条）；
  查 DOI 用 `qmode=everything`；主题级检索先用 `lit_search`（OpenAlex/S2），
  再按确认过的标题/DOI 反查本地库。
- 已知小异常：库中元数据残缺条目（空标题 [48GFD4QN]、"PDF" [S8BAWHWU]）
  会被多组查询命中，使用结果时需按标题/作者过滤。

---

# 踩坑记录 2：Hindsight daemon 在中文 Windows 上启动失败（GBK 解码崩溃）

> 2026-09-12 同一会话定位。

## 现象

`hindsight_*` 工具报 `connect ECONNREFUSED 127.0.0.1:9077`；手动运行
`node ~/.hindsight/coding-agents/dist/daemon-start.js` **静默失败**（exit 0
但服务没起来，错误只写进 `~/.hindsight/coding-agents-logs/diag.jsonl`）。

## 根因

`uvx hindsight-embed` 的 `profile create --merge` 会读取
`~/.hindsight/profiles/coding-agent.env`（UTF-8 编码，注释中含 em-dash
`—` 等字符）。中文 Windows 上 Python 3.13 的 `pathlib.read_text()` 默认用
**GBK** 解码，直接抛：

```
UnicodeDecodeError: 'gbk' codec can't decode byte 0x94 in position 673
```

## 修复

启动时设置 `PYTHONUTF8=1`（Python UTF-8 模式）即可。已固化进
`D:\AI Programs\restart-dsh.cmd` 第 4 步：

```cmd
start "Hindsight Daemon" /min cmd /c "set PYTHONUTF8=1&& node C:\Users\abbot\.hindsight\coding-agents\dist\daemon-start.js"
```

`daemon-start.js` 幂等：服务已健康时直接返回，否则执行
`profile create --merge` + `daemon start` 并等待就绪。
