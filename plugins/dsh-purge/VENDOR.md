# dsh-purge 本地留档（vendor）

## 这是什么

`dsh-purge@1.1.71` 的完整快照，2026-10-21 起由 profile 以 `link:` 方式引用：

```
C:\Users\lt\.dsh\profiles\desktop\package.json
  "dsh-purge": "link:C:/Users/lt/Documents/deepseek-harness/default-workspace/vendor/dsh-purge"
```

`C:\Users\lt\.dsh\profiles\desktop\node_modules\dsh-purge` 是指向本目录的符号链接，
所以改这里 = 改运行时生效的那份。

## 为什么用 link 而不是上游 tarball

起因是 `pnpm install` 报 `[ERR_PNPM_PATCH_FAILED]`：`patches/dsh-purge@1.1.71.patch`
已经过时（它要的两处改动，1.1.71 自己就有——`lib/identity.js` 的 `overlayOfficialIdentity`
与 `cordis.patch.yml` 的 `personaSuffix: ""`），pnpm 找不到可打的位置就整体失败。

随后确认源已经不可达（2026-10-21 实测）：

| 通道 | 结果 |
|---|---|
| `https://github.com/YuJunZhiXue/dsh-purge` | 404 / Repository not found |
| `archive/refs/heads/master.tar.gz` | 404 |
| `git ls-remote …` | remote: Repository not found |
| npm `dsh-purge` | E404（该包从未发布到 npm） |

结论：**没有可同步的上游**。`link:` 不是把更新关掉，是当前唯一还装得上的形态。
那份 patch 也一并注释掉了（`pnpm-workspace.yaml` 里有说明），已无存在意义。

## 万一以后上游回来了 / 有了新地址

1. 先探活，确认真的能取：
   ```powershell
   git ls-remote --heads https://<新地址>.git
   ```
2. 换成新地址（保底先备份本目录）：
   ```powershell
   cd C:\Users\lt\.dsh\profiles\desktop
   pnpm remove dsh-purge
   pnpm add "dsh-purge@github:<owner>/<repo>#<tag-or-commit>"
   pnpm install
   ```
   用 `#<tag>` 锁版本，不要用 master 浮动——浮动 tarball 每次上游 push 都会把
   lockfile 的 integrity 顶掉，`pnpm install` 直接失败（这也是最初那轮问题的另一半原因）。
3. 若新版本又需要本地改动，重新生成补丁而不是手改：
   ```powershell
   pnpm patch dsh-purge
   # 改完
   pnpm patch-commit <临时目录>
   ```

## 备份建议

本目录是这份包的**唯一副本**（上游已 404）。建议随 profile 一起整机备份；
真要压缩留档：

```powershell
Compress-Archive -Path vendor\dsh-purge -DestinationPath dsh-purge-1.1.71.zip
```

## 目录里值得知道的东西

- `lib/` `client.js` `cordis.patch.yml` `presets/` `skills/`：运行时真正加载的部分
- `release-notes.md`：1.1.71 的改动清单（可用来判断某行为是何时引入的）
- `README.zh-CN.md` / `README.en.md`：用法与署名要求（二开需看 `LICENSE-COMMERCIAL.md`）
- `package.json` 的 `dsh.install`：上游原本声明的三种取包方式（tarball / zip / git），现已全部失效
