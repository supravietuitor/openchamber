# OpenChamber v1.21.1 补丁发布说明

## 发布范围

本套补丁基于 OpenChamber `v1.21.1`，适用于 GitHub 上游标签 `v1.21.1` 或与其内容一致的源码树。

补丁只修改 OpenChamber，不包含 OpenCode fork 的 New API Responses 补丁。三个补丁应作为一套发布，按下列顺序应用：

1. `fork-patches/0001-config-dir-env.patch`
2. `fork-patches/0002-markdown-table-bom.patch`
3. `fork-patches/0003-response-integrity-dedup-idempotency.patch`

不要跳过顺序，也不要把 `0003` 应用到旧版 `v1.19.0` 或其他未经验证的基线。

## 补丁说明

### 0001 配置目录环境变量

文件：`packages/web/server/lib/opencode/shared.js`

行为变化：优先读取 `OPENCODE_CONFIG_DIR`，并通过 `path.resolve()` 规范化；未设置时保持原有 `~/.config/opencode` 默认路径。

用途：允许桌面版或自定义发行版把 OpenCode 配置、agents、commands 和 skills 放到指定目录，支持绿色化部署。

兼容性：未设置环境变量时行为不变。环境变量指向不存在目录时，沿用原有的目录创建流程。

### 0002 Markdown 文本下载 UTF-8 BOM

文件：`packages/ui/src/components/chat/markdown/decorate.ts`

行为变化：所有 `text/*` 下载内容在 Blob 开头写入 UTF-8 BOM；非文本下载保持原始内容。

用途：改善 Windows Excel、记事本等程序打开 CSV/Markdown 表格时的中文识别。

兼容性：只影响浏览器下载生成的文本 Blob，不改变页面中的 Markdown 渲染或非文本资源下载。

### 0003 响应完整性、流式去重与 Prompt 幂等

涉及范围：

- `packages/ui/src/sync/response-integrity.ts`
- `packages/ui/src/sync/event-reducer.ts`
- `packages/ui/src/sync/materialization.ts`
- 对应 UI 回归测试
- `packages/web/server/lib/opencode/proxy.js`
- 对应 Web proxy 回归测试
- 历史污染清理和重复消息扫描脚本

行为变化：

- 过滤已识别的响应尾部污染和内部分析泄漏。
- 将跨 delta 的文本拼接纳入清理，避免污染内容在流式边界漏出。
- 已完成的 assistant 响应才参与重复内容判定；未完成的流式响应不会因内容相同被删除。
- 历史 materialization 按 parent message 和完整文本去除重复的已完成 assistant 响应。
- `prompt_async` 按 session、directory 和 message ID 建立 15 分钟幂等闸门，避免超时重试启动第二次 turn。
- 代理重启后会探测上游已持久化的 message，尽量恢复幂等判定；探测失败时保持 fail-open，不丢弃用户发送。

误删边界：污染规则要求已知模式，普通合法文本中的相似词不应被删除；单独的 `Stop.`、`[END]` 等合法控制流文本不会被当作强内部泄漏；重复去重不会作用于未完成流式响应。

## 应用方式

在干净的 `v1.21.1` checkout 中执行：

```bash
git apply --check fork-patches/0001-config-dir-env.patch
git apply fork-patches/0001-config-dir-env.patch

git apply --check fork-patches/0002-markdown-table-bom.patch
git apply fork-patches/0002-markdown-table-bom.patch

git apply --check fork-patches/0003-response-integrity-dedup-idempotency.patch
git apply fork-patches/0003-response-integrity-dedup-idempotency.patch
```

应用完成后检查：

```bash
git diff --check
git status --short
```

回滚时必须逆序执行：

```bash
git apply -R fork-patches/0003-response-integrity-dedup-idempotency.patch
git apply -R fork-patches/0002-markdown-table-bom.patch
git apply -R fork-patches/0001-config-dir-env.patch
```

## 验证命令

先安装依赖：

```bash
bun install --frozen-lockfile
```

UI 流式响应、污染清理和历史去重测试：

```bash
cd packages/ui
bun test src/sync/__tests__/event-reducer.test.ts src/sync/__tests__/materialization.test.ts
bun run type-check
cd ../..
```

Web proxy 幂等闸门和代理行为测试：

```bash
cd packages/web
bun run test -- server/lib/opencode/proxy.test.js
node --check server/lib/opencode/shared.js
cd ../..
```

脚本回归测试：

```bash
python scripts/test-cleanup-polluted-assistant-messages.py
python scripts/test-scan-duplicate-assistant-messages.py
```

补丁可重放性验证：

```bash
git apply --check fork-patches/0001-config-dir-env.patch
git apply --check fork-patches/0002-markdown-table-bom.patch
git apply --check fork-patches/0003-response-integrity-dedup-idempotency.patch
```

## 已验证结果

在 `adapt-v1.21.1` 分支的独立 worktree 中：

- UI 定向测试：`56 pass`
- Web proxy 测试：`15 pass`
- Python 脚本测试：`8 pass`
- UI 类型检查：通过
- Web `shared.js` 语法检查：通过
- 三个补丁在全新 `v1.21.1` worktree 中按顺序重放：通过

发布前仍应在目标 Windows 构建环境执行完整 Electron 打包和人工下载验证；本说明中的测试不等同于安装包验收。

## 自动跟随上游

`.github/workflows/sync-upstream-patches.yml` 提供自动同步流程：

- 每日 UTC `02:17` 查询 `openchamber/openchamber` 的最新 `v*` tag。
- 也可在 GitHub Actions 中手动运行，并填写 `upstream_tag`，例如 `v1.22.0`。
- 流程从指定上游 tag 建立 `auto-upstream-sync` 分支，按 `0001 → 0002 → 0003` 应用补丁。
- 补丁冲突、类型检查或聚焦测试失败时，workflow 失败并停止，不会推送可合并结果。
- 验证成功后强制更新同名同步分支，并创建或更新面向 `main` 的 PR；不会自动合并。

首次启用需要先把本文件和 workflow 合并到 fork 的默认 `main` 分支，因为 GitHub 的定时 workflow 只从默认分支读取调度配置。之后的手动触发路径为：

`Actions → Sync upstream patches → Run workflow → upstream_tag=v1.22.0`

`skip_tests` 仅用于诊断补丁冲突，不应作为正常发布流程的选项。
