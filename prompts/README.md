# 提示词

## `little-code-sauce.md`

`C:\Users\lt\.dsh\prompt-inject.md` 的备份（24455 字节）。这份是 dsh-purge 的**注入文件**：
`purge_status` 里 `注入状态 / override` 显示 `default` 时，它会在每一轮被塞进系统提示。

改它的两种方式：

```powershell
dsh-purge --edit      # 用 $EDITOR 打开注入文件
# 或者直接编辑 ~/.dsh/prompt-inject.md，然后重启 DSH
```

注意：

- 这个文件是**用户文件**，`dsh-purge --revert` 不会删它（回滚只还原被清洗的宿主代码）。
- 它同时是「是否使用规则集」的开关：文件存在 → 用文件内容；不存在 → 回落规则集（`lib/rules.js`）。
- 本次备份只是留档。真要恢复：`Copy-Item little-code-sauce.md C:\Users\lt\.dsh\prompt-inject.md`。

## 写提示词时的几个硬约束（踩过的坑）

| 坑 | 说明 |
|---|---|
| 别把 `[MODE: …]` 之类标记塞进 `<system>` 外层 | 会被宿主当作新的一轮 system 节点，可能被中途降级成 user 消息（见补丁 #72/#89/#90/#91） |
| 长度 | 24KB 已经在影响首字延迟；能砍就砍，别堆反问句清单 |
| 与 persona 的关系 | 插件补丁 #4/#25/#26 已经把官方默认身份句去掉；文件里再自称一遍是重复投入，不冲突但浪费 token |
| 注入时机 | `injectOnce: false` 表示每轮都注入；设 `true` 只在第一轮 |

## 模板

[prompt-inject.template.md](prompt-inject.template.md) 是最小骨架，改头换面用。
