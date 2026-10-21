# 本地修复记录（dsh-purge 1.1.71 → 1.1.71-local.1）

上游仓库 `YuJunZhiXue/dsh-purge` 已不可达（`archive/refs/heads/master.tar.gz` 返回 404）。
profile 里原本用 tarball URL + `patchedDependencies` 装它，pnpm 拿不到原始文件就判不了
patch 是否已应用 → `ERR_PNPM_PATCH_FAILED`，整条安装回滚（连累同一次 `pnpm install`
里的其它包，例如 dsh-cyrene）。

处置：把 **已经打好 patch 的那份实体**固化为独立包，不再依赖 pnpm 的 patch 机制。

## 改动清单

### 1. 包元数据（`package.json`）

| 字段 | 改前 | 改后 | 原因 |
|---|---|---|---|
| `version` | `1.1.71` | `1.1.71-local.1` | 与上游版本区分，避免误判“有新版可升” |
| `private` | — | `true` | 上游非开源（商业许可），禁止误 `npm publish` |
| `repository` / `homepage` / `bugs` | 指向已 404 的 `YuJunZhiXue/dsh-purge` | 指向 `LUTAO581314/dsh-vault` | 死链清理 |
| `dsh.install.*` | 三个指向已 404 的 tarball/zip/git | 只留 `preferred: git` + 新仓库 git 地址 | 旧地址每次 install 都重解析，是本次故障根因 |
| `files` | 含 `lib/default-prompt-inject.md` 排除项 | 去掉该排除项、补 `LOCAL-CHANGES.md` | 提示词源文件是能力的一部分，存档要留 |
| `publishConfig.access` | `public` | `restricted` | 同上，防误发布 |

> 注意：`dsh.install` 指向的是**私有仓库**，未认证环境拉不到。当前 profile 用
> `link:` 本地路径装载，不经过这个字段；它只影响“按 git 地址重装”这类操作。

### 2. `cordis.patch.yml`（2026-10-21 修）

原文件有两条**必然 not found** 的补丁，每次 compose 都刷警告：

- 5 条 `- id: redteam-*` + `disabled: true`：目标是 dsh-redteam-store/ui/mode/mode-store/mode-ui，
  这些包在本 profile 从未安装 → `[W] [root] patch: entry "redteam-XXX" not found`。整段注释。
- 1 条 `- id: dsh-purge` + `inject: [systemPrompt, tools]`：dsh-purge 自身是由下方 `insert`
  添加的，补丁先于 insert 执行 → 必然 not found；`inject` 已写在 insert 条目里。删除。

原始文件保存在 `../../local-changes/dsh-purge/cordis.patch.yml.bak-dupfix-20261021-201546`。

### 3. `lib/index.js`（preset 注入）

已应用改动，原件 `../../local-changes/dsh-purge/lib/index.js.bak-preset-inject`。
（108331 → 109669 字节）

### 4. `presets/redteam/agent.cordis.yml`（去掉 worker thread）

已应用改动，原件 `../../local-changes/dsh-purge/presets/redteam/agent.cordis.yml.bak-drop-worker-thread`。

### 5. `lib/default-prompt-inject.md`（本地提示词）

用户自用的注入提示词，原件 `../../local-changes/dsh-purge/lib/default-prompt-inject.md.bak`。
运行时不直接读它（默认提示词已由 `scripts/embed-default-prompt.mjs` 嵌进 `lib/core.js`），
留档是为了将来能重新 embed。

## 能力验证（改动后实测）

`purge_status` → **62/70 applied, 0 pending**，与修复前完全一致。

其余 8 条为 `skipped`，是**条件不满足**而非失败，例如：

- `#32/#53/#71` Web/网页端/梁神模式的身份句补丁 → 该模式未启用
- `#40` 0.1.5 兼容 → 当前 0.2.0-rc.2
- `#77/#88` 回退标记与挂针 → 新版已无该代码路径
- `#80/#83` 工具表与 host 退出弹框 → 当前宿主版本不适用

## 装载方式（当前 profile）

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dsh-purge": "link:C:/Users/lt/Documents/deepseek-harness/default-workspace/vendor/dsh-purge"
```

`vendor/dsh-purge` 是指向本目录（`dsh-vault/plugins/dsh-purge`）的 **junction**，
所以改这里等于改运行时，不需要重装。

`pnpm-workspace.yaml` 里原来的 `dsh-purge@1.1.71: patches/dsh-purge@1.1.71.patch`
已注释停用（patch 已烘进实体文件）。

## 还原成上游原样

1. 停用本目录：profile 的 `package.json` 去掉 `dsh-purge` 依赖与 bundles 条目。
2. 用 `../../local-changes/dsh-purge/` 下的 4 个 `.bak` 覆盖回同名文件。
3. `version` 改回 `1.1.71`。
4. 拿得到上游实体的话，把它放回原位（`vendor/dsh-purge` → 真目录，非 junction）。
