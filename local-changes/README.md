# local-changes · 改动前的原件

这里存的是**被我改过的第三方包文件的原始版本**，用于 diff 和还原。
不放可运行代码，只放 `.bak`。

## dsh-purge

| 文件 | 原件对应 | 改了什么 |
|---|---|---|
| `dsh-purge/cordis.patch.yml.bak-dupfix-20261021-201546` | `plugins/dsh-purge/cordis.patch.yml` | 注释掉 5 条 not-found 的 `redteam-*` 补丁 + 删掉 1 条空转的 `- id: dsh-purge` |
| `dsh-purge/lib/index.js.bak-preset-inject` | `plugins/dsh-purge/lib/index.js` | preset 注入改造（108331 → 109669 字节） |
| `dsh-purge/lib/default-prompt-inject.md.bak` | `plugins/dsh-purge/lib/default-prompt-inject.md` | 用户自用提示词（本地化前） |
| `dsh-purge/presets/redteam/agent.cordis.yml.bak-drop-worker-thread` | `plugins/dsh-purge/presets/redteam/agent.cordis.yml` | 去掉 worker thread |

还原单个文件：

```powershell
$lc='C:\Users\lt\Documents\dsh-vault\local-changes\dsh-purge'
$pk='C:\Users\lt\Documents\dsh-vault\plugins\dsh-purge'
Copy-Item "$lc\lib\index.js.bak-preset-inject" "$pk\lib\index.js" -Force
```

还原后**重启 DSH** 生效（插件模块是启动时加载的）。
改动的完整理由见 [../plugins/dsh-purge/LOCAL-CHANGES.md](../plugins/dsh-purge/LOCAL-CHANGES.md)。
