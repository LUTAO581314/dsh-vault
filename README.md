# dsh-vault

我的 DeepSeek Harness（DSH）私货仓库：**插件 / 技能 / MCP / 提示词 / 运行配置** 一处存放。
上游消失的包、自己写的插件、每天在改的 profile 配置，这里都留一份能跑的存档。

> ⚠️ **保持 private**。`plugins/dsh-purge` 是商业许可软件，LICENSE 禁止公开源码。
> 细节见 [LICENSE-NOTICE.md](LICENSE-NOTICE.md)。

> 🔐 **密钥不入库**。同步脚本会把 `password` 行、`*_KEY` / `*_TOKEN` / `*_SECRET` 的 JSON 值
> 替换成 `***REDACTED***`；提交前还会再扫一遍，命中就中止。真实值只留在本机
> `~/.dsh/redteam/config.json` 等位置，还原时手动填回。

## 目录

| 路径 | 是什么 | 来源 / 状态 |
|---|---|---|
| [`config/desktop/`](config/desktop/) | desktop profile 全量快照：`cordis.patch.yml`（196 KB 主配置）、`package.json`、`pnpm-lock.yaml`、`patches/`、`PRESETS.md`、`cyrene-preset-declarations.yml` | 每天 23:30 自动同步 |
| [`config/quant-advisor-preset/`](config/quant-advisor-preset/) | 量化投资顾问 preset 的配置与 playbook | 快照 |
| [`plugins/dsh-purge/`](plugins/dsh-purge/) | 破甲插件（清洗提示词 + 审批/沙箱绕过 + 红队演练台），**上游 404 后的本地修复版** | 已装，62/70 补丁 applied |
| [`plugins/dsh-rea/`](plugins/dsh-rea/) | REA（Reverse Engineer Anything）接入：注册 `rea` MCP、装技能、加 `rea_probe` / `rea_doctor` 路由工具 | 已装，MCP 暴露 207 个工具 |
| [`plugins/dsh-multizen-browser/`](plugins/dsh-multizen-browser/) | 自研侧边栏浏览器插件（MultiZen CDP screencast，替代沙箱 iframe） | 0.1.0，只此一份 |
| [`plugins/dsh-agent-preset-editor/`](plugins/dsh-agent-preset-editor/) | 自研「预设编辑器」（npm 名 dsh-agent-preset-editor）：接管设置页的预设页，可视化改 preset 插件面 / 系统提示词模块 / skill 开关 | 0.59.0，待发市场 |
| [`mcp/multizen/`](mcp/multizen/) | 自建 MCP server（`server.mjs`，stdio → MultiZen 22 个工具） | 被 `cordis.patch.yml` 直接引用 |
| [`mcp/`](mcp/) | MCP 连接样例与踩坑记录 | — |
| [`skills/reverse-engineer-anything/`](skills/reverse-engineer-anything/) | 逆向路由技能文本（native / .NET / Electron / APK / 固件 / 浏览器） | 已装到 `~/.dsh/skills` |
| [`skills/paper-figure/`](skills/paper-figure/) | 论文 → 架构图技能（PDF 取图、图注登记、DrawAI / Archify 出图） | 自写，公开仓 `scifig` 只是近似版 |
| [`presets/expert-orchestrator/`](presets/expert-orchestrator/) | 专家编排 preset，含 `expert-lessons`、`expert-methods`、三个技能 | 已部署 |
| [`presets/redteam/`](presets/redteam/) | 红队 preset（`agent.cordis.yml` 为本地改过 worker-thread 的版本） | 已部署 |
| [`redteam/`](redteam/) | dsh-purge 红队运行配置：`config.json`（密钥已脱敏）、`setup.sh`、`knowledge.db`、23 个技能 | 运行态快照 |
| [`prompts/prompt-inject.md`](prompts/prompt-inject.md) | **实际在用的**全局注入提示词（24 KB） | 快照 |
| [`prompts/`](prompts/) | 注入模板与说明 | — |
| [`local-changes/`](local-changes/) | 第三方包被改动前的原始文件（`.bak`），用于还原与 diff | — |
| [`scripts/sync.ps1`](scripts/sync.ps1) | 一键同步本机 → 仓库，可选提交推送 | 计划任务 `DSH-Vault-Sync` |

## 本机路径映射

profile 目录：`C:\Users\lt\.dsh\profiles\desktop`

`package.json` 里两个本地包走绝对 `link:`：

```jsonc
"dsh-purge": "link:C:/Users/lt/Documents/deepseek-harness/default-workspace/vendor/dsh-purge",
"dsh-rea":   "link:C:/Users/lt/Documents/deepseek-harness/default-workspace/dsh-rea"
```

这两个路径是 **junction**，指向本仓库的 `plugins/`：

```
default-workspace\vendor\dsh-purge  →  dsh-vault\plugins\dsh-purge
default-workspace\dsh-rea           →  dsh-vault\plugins\dsh-rea
```

所以：**改这里就是改运行时**，profile 不用重装。重建 junction：

```powershell
cmd /c mklink /J "C:\Users\lt\Documents\deepseek-harness\default-workspace\vendor\dsh-purge" "C:\Users\lt\Documents\dsh-vault\plugins\dsh-purge"
cmd /c mklink /J "C:\Users\lt\Documents\deepseek-harness\default-workspace\dsh-rea" "C:\Users\lt\Documents\dsh-vault\plugins\dsh-rea"
```

## 自动同步

```powershell
# 只同步文件，不提交（调试）
pwsh -File scripts\sync.ps1 -NoCommit

# 同步 + commit + push
pwsh -File scripts\sync.ps1 -Push
```

计划任务 `DSH-Vault-Sync` 每天 **23:30** 跑一次（错过则开机后补跑），日志在 `logs/sync.log`（不入库）。
同步范围：profile 配置、`dsh-multizen-browser`、`mcp/multizen`、`paper-figure`、两个 preset、
`redteam` 运行配置、`prompt-inject.md`、量化 preset；`dsh-purge` / `dsh-rea` 走 junction，无需复制。

## 还原到新机

1. 装好 DSH，创建 `desktop` profile，先备份 `~/.dsh/profiles/desktop`。
2. `git clone git@github.com:LUTAO581314/dsh-vault.git C:\Users\lt\Documents\dsh-vault`
3. 按上面的命令重建两个 junction，再 `pnpm install`（或用 `config/desktop/package.json` 覆盖后装）。
4. 把 `config/desktop/` 里的文件覆盖回 `~/.dsh/profiles/desktop/`；`config/quant-advisor-preset/` 放回工作区。
5. 把 `skills/`、`presets/`、`redteam/`、`mcp/multizen/`、`plugins/dsh-multizen-browser/` 复制回 `~/.dsh` 对应目录。
6. 用真实值填回两处脱敏：`config/desktop/cordis.patch.yml` 的 VPS `password`、
   `redteam/config.json` 的 `FOFA_KEY` / `SHODAN_KEY`。
7. 重启 DSH，跑 `purge_status` 和 `rea_doctor` 自检。

## 为什么 dsh-purge 要自己维护

上游 `YuJunZhiXue/dsh-purge` 已下线（`master.tar.gz` 404）。原本 profile 用
tarball URL + `patchedDependencies` 装它，pnpm 拿不到原始文件就判不了 patch 状态 →
`ERR_PNPM_PATCH_FAILED`，**整条 pnpm install 回滚**，连带别的包（如 dsh-cyrene）装不上。

现在：patch 已烘进实体文件，`pnpm-workspace.yaml` 里那条 patchedDependencies 注释停用。
详见 [plugins/dsh-purge/LOCAL-CHANGES.md](plugins/dsh-purge/LOCAL-CHANGES.md)。

## 自检

```
purge_status     # 期望 62/70 applied, 0 pending（8 条 skipped 是条件不满足）
rea_doctor       # 期望 MCP 已连、引擎/设备清单齐全
```

## 约定

- 新插件 → `plugins/<name>/`，再 junction 到 profile 用的路径。
- 新技能 → `skills/<name>/SKILL.md`，装到 `~/.dsh/skills/<name>/`。
- 新 preset → `presets/<name>/`，装到 `~/.dsh/.agent-presets/<name>/`。
- 改动第三方包 → 原件先进 `local-changes/<pkg>/`，再写 `LOCAL-CHANGES.md`。
- 每个包留 `README.md` 说清「它干什么、怎么装、怎么退」。
- 密钥、`.env`、`.credentials.yaml` 永不入库；确需记录就写占位符。
