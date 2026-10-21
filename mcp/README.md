# MCP 连接配置

DSH 的 MCP 连接在 **bundle 补丁行** 里声明（`cordis.patch.yml` 的 `insert`），
不是在某个 JSON 文件里点选。一行一个 server。

## 行格式（照抄已装插件的真实形状）

```yaml
- insert:
    - id: mcp-rea
      name: '@deepseek-ai/dsh-mcp-client'
      inject: [tools]
      config:
        serverName: rea
        transport: stdio
        command: <绝对路径的 node>
        args: [<本地 mcp 入口 .js>]
        env: {}
        toolCallTimeoutMs: 180000      # 默认 60000；逆向/反编译类会超
        failOnStartupError: false      # 起不来不炸整个 profile
        maxInstructionBytes: 32768
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 10
```

字段要点：

| 字段 | 说明 |
|---|---|
| `serverName` | 工具名前缀来源，决定 `mcp__<serverName>__<tool>` |
| `transport` | `stdio`（本地进程）或 `sse` / `streamable-http` |
| `command` + `args` | stdio 用；**Windows 上给 node.exe 的绝对路径**最稳，别指望 PATH |
| `toolCallTimeoutMs` | 长任务调到 180000+，否则大仓库分析会被砍 |
| `failOnStartupError` | `false`：server 挂了只是没有工具，不影响 DSH 启动 |
| `maxInstructionBytes` | 工具说明塞进上下文的字节上限 |

## 每个连接的通用验尸顺序

1. `node <entry> --help` / 直接 `echo '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | node <entry>` —— 进程本身活不活。
2. 工具列表：`listTools` 返回几条？0 条说明 server 起来了但没注册能力。
3. 超时：跑一次最慢的工具，看是否撞 `toolCallTimeoutMs`。
4. 重启 DSH 才会重新 compose 补丁行。

## 本仓库相关的两个 server

| server | 入口 | 备注 |
|---|---|---|
| `rea` | `rea-agents` 包的 `mcp` 子命令（`npx -y rea-agents@latest mcp`） | 由 `plugins/dsh-rea` 自动注册，不需要手写这行 |
| `multizen` | 浏览器指纹 profile 驱动 | 见 `~/.dsh/dsh-multizen-browser`，同样 bundle 行声明 |

样例文件：[rea.mcp.example.yml](rea.mcp.example.yml)（hand-write 时照抄）。
