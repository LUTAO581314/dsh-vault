# LICENSE-NOTICE · 仓库内各部分的授权状况

**这个仓库必须保持 private。** 原因见下。

## plugins/dsh-purge

版权归 **小杨（YuJunZhiXue）**，**不是开源软件**（`LICENSE` 原文：「本软件不是开源软件。当前分支也不是 MIT。」）。

LICENSE 第二部分明确禁止：

- 把源码或核心实现**公开到别的仓库**、网盘、频道
- 改名、去署名、冒充作者或「官方」
- 出售、卖课、白标、OEM、托管服务

因此：

- 本仓库把 dsh-purge **存档为私有备份**，供本人在自己的机器上使用；不做任何形式的分发。
- 不要把这个仓库转成 public，也不要把 `plugins/dsh-purge` 的内容复制到别处公开。
- 上游已于 2026-10-27 起转闭源，新版只在 https://t.me/LLM_PoJia/271 发布。
- 需要再分发/商用授权：`a2269198325@163.com`，标题「dsh-purge 商业许可」。

上游仓库 `YuJunZhiXue/dsh-purge` 现已不可达，本目录是基于**本机已安装实体**的修复存档，
改动范围见 [plugins/dsh-purge/LOCAL-CHANGES.md](plugins/dsh-purge/LOCAL-CHANGES.md)。

## 其它内容

`plugins/dsh-rea`、`skills/reverse-engineer-anything`、`mcp/`、`prompts/` 为本仓库作者自建，MIT。
其中 `reverse-engineer-anything` 技能的操作对象是 [rea](https://github.com/morluto/rea)（第三方 npm 包 `rea-agents`），
本仓库只放技能文本，不包含其源码。

## 第三方引用

- `dsh-purge/docs/redteam-upstream-LICENSE`、`docs/redteam-upstream-DISCLOSURE`：上游随包附带的第三方声明，原样保留。
