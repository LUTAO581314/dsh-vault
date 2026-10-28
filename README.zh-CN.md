# DSH 插件与 MCP 配置仓库

本仓库保存 DeepSeek Harness（DSH）的 desktop 插件清单、MCP 定义和本地自制插件源码。dsh-purge 使用上游 Git 子模块并固定提交。本仓库不包含聊天记录、运行数据、MultiZen 安装程序或本机令牌。

## 安装

安装 Node.js、npm、Git 和 pnpm（或 Corepack），然后在 PowerShell 执行：

    git clone --recurse-submodules https://github.com/LUTAO581314/dsh-vault.git
    cd dsh-vault
    .\scripts\install.ps1

安装器会把仓库清单中的依赖与 bundle 合并进 DSH desktop profile，保留现有插件；将三个插件复制到 DSH_HOME/plugins；安装固定版本的 REA MCP；再把 REA server 合并到工作区的 .dsh/mcp.json。如果检测到本机 MultiZen token 文件，会把 MultiZen MCP 合并到 DSH desktop profile。更改前会备份 profile manifest、锁文件、Cordis 配置、工作区 MCP 配置和已安装的插件目录。

默认 DSH_HOME 为 %USERPROFILE%/.dsh，默认工作区为 %USERPROFILE%/Documents/deepseek-harness/default-workspace。可指定其他目录：

    .\scripts\install.ps1 -DshHome 'D:\Apps\dsh-home' -Workspace 'D:\Work\my-workspace'

先运行 -WhatIf 查看操作目标。完成安装后重启 DSH。

## 插件与 MCP

- profiles/desktop/package.json 保存当前 desktop profile 的依赖版本、来源和启用 bundle。
- profiles/desktop/mcp-servers.json 描述 MultiZen 的 Streamable HTTP 地址和 token 文件位置，不包含 token。
- plugins/dsh-multizen-launcher 与 plugins/dsh-sidebar-pet 是本仓库维护的自制插件。
- plugins/dsh-purge 是 LanJinGod/dsh-purge 上游仓库的子模块，固定在提交 8023a74340acead66f88913d539b605f3754c167。保留上游许可证和署名；上游要求再创作时注明 YuJunZhiXue/dsh-purge 来源。
- mcp/package.json 固定 REA MCP npm 版本；REA 使用工作区级 stdio 配置。

MultiZen 是 DSH profile 级 MCP，地址为 http://127.0.0.1:7777/mcp。先安装 MultiZen 并完成本机授权，再运行安装器。安装器从 %APPDATA%/MultiZen/mcp-token 读取 token，将其写入本机 DSH profile 配置；token 不会输出到终端或保存到仓库。仓库不含 MultiZen 程序。

MultiZen 启动插件默认查找 %LOCALAPPDATA%/Programs/MultiZen/MultiZen.exe。安装在其他位置时，设置 DSH_MULTIZEN_EXE 或调整插件 executable 配置。

dsh-purge 加入 bundle 后不会自动应用上游补丁。重启 DSH 后，如需使用它，请在 dsh-purge 页面检查并点击 Apply。

## 更新

    git pull
    git submodule update --init --recursive
    .\scripts\install.ps1

新增插件或 MCP 时，更新对应清单和源码后重新运行安装器。
