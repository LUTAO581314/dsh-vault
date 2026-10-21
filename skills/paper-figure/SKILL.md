---
name: paper-figure
description: "论文 → 架构图的拆解与制图规范：PDF/arXiv 取全文、抽页图与页内嵌图、图注登记、节点-边表建模，再按图型选 DrawAI 画布或 Archify 出矢量图。Use when the user asks to draw a paper architecture/workflow/pipeline figure, to 拆解/复刻 a paper's figures, to turn a PDF or arXiv paper into a diagram, or says 论文画图 / 架构图 / 画个流程图."
---

# 论文画图：从 PDF 到矢量图

用户要画论文里的架构/流程/模型结构图时走这条流水线。**结构从材料来，不许凭空发挥。**

## 一、30 秒流程

1. 取料：本地 PDF → 跑 `pdf-extract.py`；DOI/arXiv → `read_by_doi` / `read_arxiv_paper`。
2. 拆解：图注抄成一句话 → 登记图清单 → 抽节点表 + 边表 + 符号表，落 `outline.md`。
3. 选型：关系图走 **DrawAI 画布**（可交付 .drawio 源文件）；要好看的成品走 **Archify**；AI 生图只做示意/封面。
4. 出骨架 → 上文字 → 调样式 → 排版（顺序别倒，倒了返工）。
5. 自查 + 交付三件套（src / svg-pdf / png）+ 图注。

## 二、PDF 抽解（本机已验证）

```powershell
python C:\Users\lt\.dsh\skills\paper-figure\scripts\pdf-extract.py paper.pdf --out ref\ --dpi 300
python ... --pages 1-3,7 --no-images     # 只抽指定页、跳过嵌图
```

产出：`text.md`（按页分隔的正文，图注都在里面）、`pages/pNNN.png`（300dpi，给 `modlens_read_image` 看）、`images/`（页内嵌图，常就是 Figure 原图）、`summary.txt`（每页字符/图片数，一眼定位有图的页）。

依赖只有 pymupdf（`python -c "import pymupdf"` 验证；缺就 `python -m pip install pymupdf`）。
没有 python 时退路：arXiv 用 `read_arxiv_paper`，DOI 用 `read_by_doi`，截图/粘图用 `modlens_read_image`。

## 三、拆解模板（落 outline.md）

```markdown
# 论文：《标题》(venue year, DOI)
## 图清单
| 图号 | 图注（一句话）| 回答什么问题 | 图型 | 页 |
|---|---|---|---|---|
| Fig.1 | 方法总览 | 整体怎么跑 | 架构图 | 2 |
## 符号表
| 符号 | 含义 | 维度 |
|---|---|---|
| z_t | 融合特征 | d=512 |
## 节点
| id | 名称 | 类别 | 备注 |
|---|---|---|---|
| enc | Text Encoder | 模块 | 冻结 |
## 边
| from | to | 含义 | 样式 |
|---|---|---|---|
| enc | fusion | z_t | 实线 + 张量标注 |
```

改图先改这张表；表里没有的东西不许出现在图上。

## 四、图型 → 工具

| 材料 | 图型 | 工具 |
|---|---|---|
| 模块/组件连接 | 架构图（分层，底→顶；Fig.1 做总览）| DrawAI / archify |
| 步骤与判断分支 | 流程图 | DrawAI / archify |
| 参与方与时间顺序 | 时序图 | archify（`sequenceDiagram` 输入）|
| 状态与迁移条件 | 状态机 | DrawAI / archify |
| 张量形状与流向 | 数据流图 | DrawAI |
| 前向/反向/参数更新 | 训练循环图 | DrawAI |

- DrawAI：`diagram_read` 拿现状与 revision → `diagram_apply` 批量 ops（`as:"enc"` 起别名，`from/to` 用别名；**改接边用 `setEdge`**，别 remove+addEdge）→ `diagram_read render:true` 看图自查（第一次多为 `pending`，再调一次）。
- 位图复刻矢量：`{op:"traceImage", image:"ref/pages/p003.png", removeBg:true, preset:"lineart"}`，按返回 `hint` 调 `epsilon`/`colors`。
- archify：给它 plain-language 需求或 `flowchart`/`sequenceDiagram`/`stateDiagram` Mermaid，产出可开 HTML，再导 PNG/SVG。
- AI 生图（`generate_image`）：只做示意/封面/氛围图，**不画连线关系**，中文文字别指望它排整齐。

## 五、论文级规范

- 矢量优先：`.svg` / `.pdf` 交付；`.png` ≥300dpi 只做预览。
- 尺寸：单栏 88mm，双栏 180mm；正文 7–8pt（最小 6pt）；线宽 0.5–1pt。
- 颜色 ≤4 色含灰阶，同语义同色，**黑白打印可读**。
- 网格对齐、通道等距、连线不穿节点、文字不压线；箭头与张量标注写清。
- 图注 = 图号 + 一句结论式标题 + 符号说明。

## 六、交付

```
figures/
  outline.md  src/  export/  ref/
```
命名 `fig1-overview.svg`；回复给路径链接 + 尺寸建议 + 图注草稿，开头一句"这张图讲了什么"。

## 七、坑

- 生图模型"读不到设置"：默认解析走 profile 里 `image-gen` 行的 `config.provider`（本机是 `google`），与设置页所选是两套。**显式传 `provider`+`model`**；走 ruikon 中继用 `provider:"openai-compat"` + `model:"gpt-image-2"` + `openaiCompatBaseURL`，key ref 是 `DSH_IMAGE_GEN_OPENAI_COMPAT_KEY`。
- Windows 控制台是 GBK：脚本往 stdout 打中文会花屏，读**文件**不要读 stdout。
- 分类图、饼图这类"数据图"不走本技能，直接 matplotlib 出矢量 PDF。

## 八、生图链路勘察记录（2026-10-20，机器不变就不用重查）

- `$DSH_HOME/profiles/desktop/node_modules/dsh-image-gen/cordis.patch.yml` 钉的是 `provider: google`。
- 同 profile 的 `cordis.patch.yml` 另有一个 **LLM** provider `image`：`api: openai-completions`、`baseURL: https://api.ruikon.cc`、`apiKeyEnv: IMAGE_API_KEY`，models `gpt-image-2` / `gpt-image-2.5` / `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`。
- dsh-image-gen 认自己的凭据 ref：`openai`→`OPENAI_API_KEY`、`openai-compat`→`DSH_IMAGE_GEN_OPENAI_COMPAT_KEY`、`google`→`GEMINI_API_KEY`、`seedream`→`ARK_API_KEY`、`dashscope`→`DASHSCOPE_API_KEY`、`xai`→`XAI_API_KEY`、`zhipu`→`ZHIPUAI_API_KEY`。
- `openai-compat` 必须同时给 `openaiCompatBaseURL` 与 `openaiCompatModel`，缺一个就抛 "requires a base URL / requires a model name"。
- 2026-10-20 时 `.env` 无 `DSH_IMAGE_GEN_OPENAI_COMPAT_KEY`；`.credentials.yaml` 的 refs 有 `GEMINI_API_KEY` / `IMAGE_API_KEY`。

排障顺序：
1. `provider:"google"` + 设置页模型名跑一张最小图；报"模型不存在"就是 provider/model 不匹配。
2. 走 ruikon 中继：`provider:"openai-compat"` + `model:"gpt-image-2"` + `openaiCompatBaseURL:"https://api.ruikon.cc/v1"`，key 补成 `DSH_IMAGE_GEN_OPENAI_COMPAT_KEY`。
3. 报错原文贴给用户，不自己编"应该可以"；要用户出手时一次说清 provider / baseURL / 模型名 / key 填哪。
