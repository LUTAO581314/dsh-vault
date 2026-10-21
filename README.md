# dsh-vault

我的 DeepSeek Harness（DSH）私货仓库：**插件 / 技能 / MCP / 提示词** 一处存放，
上游消失的包在这里留一份能跑的存档。

> ⚠️ **保持 private**。`plugins/dsh-purge` 是商业许可软件，LICENSE 禁止公开源码。
> 细节见 [LICENSE-NOTICE.md](LICENSE-NOTICE.md)。

## 目录

| 路径 | 是什么 | 状态 |
|---|---|---|
| [`plugins/dsh-purge/`](plugins/dsh-purge/) | 破甲插件（清洗提示词 + 审批/沙箱绕过 + 红队演练台），**上游 404 后的本地修复版** | 已装，62/70 补丁 applied |
| [`plugins/dsh-rea/`](plugins/dsh-rea/) | REA（Reverse Engineer Anything）接入：注册 `rea` MCP、装技能、加 `rea_probe` / `rea_doctor` 路由工具 | 已装，MCP 暴露 207 个工具 |
| [`skills/reverse-engineer-anything/`](skills/reverse-engineer-anything/) | 逆向路由技能文本（native / .NET / Electron / APK / 固件 / 浏览器） | 已装到 `~/.dsh/skills` |
| [`mcp/`](mcp/) | MCP 连接配置样例与踩坑记录 | — |
| [`prompts/`](prompts/) | 注入提示词模板与说明 | — |
| [`local-changes/`](local-changes/) | 上述包被改动前的原始文件（`.bak`），用于还原与 diff | — |

## 装载方式

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
- 改动第三方包 → 原件先进 `local-changes/<pkg>/`，再写 `LOCAL-CHANGES.md`。
- 每个包留 `README.md` 说清「它干什么、怎么装、怎么退」。
