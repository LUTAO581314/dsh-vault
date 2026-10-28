# dsh-sidebar-pet 0.1.0

将 DSH 侧边栏中勾选的项目提供给现有桌宠菜单。插件独立保存勾选项；客户端直接调用 `/dsh-pet-7340/menu/item`，使用 `owner=dsh-sidebar-pet` 与 `labels`，宿主仅管理配置和诊断。

## 包结构与安装

ESM 宿主入口为 `lib/index.js`，导出 `name`、`inject=["webServer"]`、`apply(ctx)`。浏览器入口通过 `exports["./client"]` 指向 `./lib/client.js`，使用与 dsh-armory 相同的 `window.__ModuleLoader__.load({id:"dsh-sidebar-pet",factory(require){...}})` IIFE loader 形式；仓库包含宿主与浏览器源码。`dsh.client.platform` 为 `web`，`dsh.bundle.patch` 指向 `cordis.patch.yml`，补丁插入同名 name/id。

仓库脚本 install.ps1 会复制此包到 DSH_HOME/plugins，并将它注册为 desktop bundle。重启 DSH 后，用 /sidebar-pet/status 检查宿主。

## 配置位置

从包所在路径向上寻找 `profiles/<profile>/node_modules`，配置存入该 profile 的独立 `sidebar-pet.json`。标准 desktop 安装对应 `%USERPROFILE%/.dsh/profiles/desktop/sidebar-pet.json`，也支持 pnpm 嵌套布局。工作区开发或符号链接安装应在启动 DSH 前设置绝对目录环境参数 `DSH_SIDEBAR_PET_PROFILE_DIR`，例如你的 DSH desktop profile 目录。找不到 profile 时诊断返回 503，避免将配置意外写进 cwd。

## HTTP 契约

- `GET /sidebar-pet/config`：返回 `{ "selected": [] }` 或已保存的标签数组；文件缺失视为空。
- `POST /sidebar-pet/config`：接受且只接受 `{ "selected": ["标签"] }`，成功返回保存后的相同结构。最多 128 项，每项为非空字符串、最长 128 个 UTF-16 单元，无控制字符、重复值或额外字段。JSON 请求和持久文件均限制 16 KiB。
- `GET /sidebar-pet/status`：返回版本、配置文件路径、选中数量、限制及桌宠 API owner；损坏配置返回显式错误。

浏览器 Origin 必须与请求 Host 及实际 HTTP/HTTPS 协议相同；Fetch Metadata 只接受 same-origin/none。无 Origin 的原生调用可用；不信任 forwarded headers。错误分别使用 400、403、405、413、415、500、503，所有响应 no-store，无 CORS 开放。写入经过目标文件串行队列，在同目录创建独占临时文件、fsync 后 rename 替换，失败清理临时文件；多个进程同时写入时为完整文件的最后写入者胜出。路由注册由 ctx.effect 管理，在卸载时撤销。

## 取消与恢复

取消所有勾选时保存 `{ "selected": [] }`，客户端应清除其 owner 的桌宠菜单项。禁用或卸载插件后，客户端负责清理该 owner 和界面事件，宿主自动移除两个路由。配置默认保留；再次启用时恢复勾选。需要恢复初始空状态时，在停用插件后备份并删除该 profile 的 `sidebar-pet.json`，或启用状态下调用上述空数组保存。其他插件配置及桌宠自身菜单不受影响。

## 测试

在包目录执行 `node ./lib/index.js --self-test` 或 `npm test`。node:test 自测内置在宿主文件，仅在显式直接执行 --self-test 时运行，避免增加交付范围之外的测试文件。使用模拟 webServer routes、Readable 请求与独立临时 profile，覆盖默认读取、保存后重新挂载读取、并发原子保存、坏 schema/JSON 不覆盖、同源与跨源检查、方法及媒体类型、声明和流式大小限制、损坏配置诊断、effect 卸载。测试临时目录在结束时清理，不触及真实 profile。
