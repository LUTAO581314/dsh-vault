# 量化投资顾问团 · Agent 预设

一个装在 DSH 里的七席投研团队模式。选了它，新会话就带着「宏观 / A股 / 美股 / 币圈 / 舆情事件 / 量化 / 风控」的编制、数据源路由表和作业流程开工。

- 声明文件：`quant-advisor-preset/cordis.patch.yml`（本体，可直接复制到别的 profile）
- 取数脚本：`quant-advisor-preset/market-feed.ps1`（零依赖多市场行情，免费无 key）
- 已合并进：`C:\Users\lt\.dsh\profiles\desktop\cordis.patch.yml`（末尾 `- insert: - id: preset-quant-advisor`）
- 备份：`cordis.patch.yml.bak-before-quant-preset-20261020214000`
- preset id：`quant-advisor`　显示名：**量化投资顾问团**　order：30

---

## 一、怎么启用（两步）

1. **重启 DSH Desktop**（profile 的 patch 层只在启动时加载）。
2. 新任务页的**模式选择器**里会多出「量化投资顾问团」卡片。选中它开一个新会话。
   - 想设成默认：设置 → 模式 → 设为默认。
   - 老会话不会变（会话保留启动时的插件与提示词），必须开新会话。

**验收三个点**：
- 模式下拉里能看到卡片，且不显示「加载失败」。
- 问「上证多少点」，它直接调 `quote(["sh000001"])` 回答，**不派 agent**。
- 让它「查 600519 的资金流」，它应当跑 `market-feed.ps1 600519 -Mode flow`（东财），**不是**去 curl `/dsh-plugin-stock-x/*`（那条路由对模型侧返回 403）。

如果卡片显示加载失败：说明某一行插件名在当前 profile 里解析不到，把失败诊断发给主窗口，别自己在 patch 里改包名试。

---

## 二、编制与职责

| 席位 | 管什么 | 主力数据面 |
|---|---|---|
| 🌐 宏观政策 | 央行/财政/发改/证监会政策原文、LPR·社融·PMI·CPI/PPI、美联储 FOMC·非农、美债、美元指数、地缘 | `web_search` + `web_fetch`（官网原文优先）、`multi-search-engine`（16 引擎） |
| 📈 A股盘面 | 指数/板块轮动/主力资金/涨停梯队/情绪周期 | `quote` `chart`、`market-feed.ps1 -Mode sectors\|flow\|kline` |
| 🇺🇸 美股海外 | 三大指数/科技七巨头/财报/中概/汇率 | `market-feed.ps1`（Yahoo：`NVDA` `0700.HK` `^GSPC` `^IXIC` `^DJI`） |
| ₿ 加密 | BTC/ETH/山寨/ETF 流入/链上 | `quote(["bitcoin"])` `chart`（CoinGecko）、`market-feed.ps1 BTC-USD` |
| 📰 舆情事件 | 公告/研报/快讯/灾情/事故/制裁 → 产业链映射 | `web_search`、`multi-search-engine`、`cn-financial-scraper` |
| 🧪 量化回测 | 策略 → 回测 → 收益/回撤/夏普/胜率 | `strategy-backtest-expert` 专家、本地 Python/pwsh |
| 🛡️ 风控仓位 | 仓位/相关性/最大回撤/ATR 止损/压力测试/再平衡 | 各席数据 + `fund-advisor` 技能 |

**分级响应**（写在人设里，防止小题大做烧钱）：L0 秒答（单标的报价/单条新闻，直接调工具）→ L1 快研（一只股票，串工具或 1 个 subagent）→ L2 团队（跨市场/组合/事件链，2–4 席并行）→ L3 战役（季度策略/组合重构，全席 + 回测 + 出文件）。

---

## 三、market-feed.ps1：零依赖多市场取数

不需要 Python、不需要 pip、不需要任何 API key。A股走东方财富 push2，港股/美股/全球指数/加密走 Yahoo Finance，东财挂掉自动回退腾讯。

```powershell
# 多市场报价
pwsh -File quant-advisor-preset\market-feed.ps1 "600519,sh000001,NVDA,0700.HK,^GSPC,BTC-USD"

# 个股深度：开高低昨收 + 量额 + 换手 + PE + 总市值
pwsh -File quant-advisor-preset\market-feed.ps1 600519,sh000001 -Mode detail

# A股主力资金流（超大单/大单/中单/小单，单位亿元）
pwsh -File quant-advisor-preset\market-feed.ps1 600519 -Mode flow -Days 5

# 板块涨幅榜（涨幅/主力净额/涨跌家数/领涨股）
pwsh -File quant-advisor-preset\market-feed.ps1 -Mode sectors -Top 10

# 日K（A股前复权）
pwsh -File quant-advisor-preset\market-feed.ps1 600519 -Mode kline -Days 30

# 概念板块涨幅榜（-BoardType industry 为行业板块；行业 496 个 / 概念 516 个）
pwsh -File quant-advisor-preset\market-feed.ps1 -Mode board -BoardType concept -Top 10

# A股涨幅 / 跌幅 / 成交额榜（全市场 5500+ 只）
pwsh -File quant-advisor-preset\market-feed.ps1 -Mode rank -RankType gain -Top 20
pwsh -File quant-advisor-preset\market-feed.ps1 -Mode rank -RankType amount -Top 20

# 中文名 / 拼音 → 代码 + secid（连港股一起解析）
pwsh -File quant-advisor-preset\market-feed.ps1 -Mode lookup -Query 宁德时代

# 机器可读
pwsh -File quant-advisor-preset\market-feed.ps1 NVDA,BTC-USD -Json
```

符号写法：`600519` / `sh000001`（指数）/ `0700.HK` / `NVDA` / `^GSPC`（必须 URL 编码，脚本已处理）/ `BTC-USD`。

**实测输出（2026-10-20 收盘后跑的真实返回）**：

```
600519     贵州茅台              1331.88     0.52%  CNY (eastmoney)
000001     上证指数              3735.37     0.12%  CNY (eastmoney)
NVDA       NVIDIA Corporation     213.31    -6.66%  USD (yahoo)
0700.HK    TENCENT             410.4     -3.62%  HKD (yahoo)
^GSPC      S&P 500              7673.63    -1.69%  USD (yahoo)
BTC-USD    Bitcoin USD         81653.64     0.19%  USD (yahoo)

── 板块涨幅榜
其他数字媒体   13.62%  主力 3.83亿  涨2/跌0  领涨 凡拓数创
诊断服务        9.53%  主力 3.18亿  涨5/跌0  领涨 迪安诊断
燃料电池        6.08%  主力 0.02亿  涨1/跌0  领涨 亿华通-U

── 600519 主力资金流（亿元）
2026-10-20  主力 +0.609  超大单 -0.326  大单 +0.935  中单 -0.602  小单 -0.006
```

---

## 四、macro-feed.ps1：政策·新闻·灾情（事件驱动）

第二个脚本，同样零依赖、零 key。`market-feed` 回答"现在多少钱"，它回答"为什么涨跌、下一个雷在哪"。

```powershell
# 政策与突发快讯（首选主源：东财 7x24，带关联板块与美股代码）
pwsh -File quant-advisor-preset\macro-feed.ps1 -Mode flash -Limit 20
pwsh -File quant-advisor-preset\macro-feed.ps1 -Mode flash -Filter 降准

# 财经新闻（华尔街见闻 + Bloomberg RSS）
pwsh -File quant-advisor-preset\macro-feed.ps1 -Mode news -Limit 10 -Filter 关税

# 灾情：全球地震（USGS，近 24 小时）
pwsh -File quant-advisor-preset\macro-feed.ps1 -Mode quake -MinMag 5

# 灾情：天气（Open-Meteo，当前 + 3 日预报）
pwsh -File quant-advisor-preset\macro-feed.ps1 -Mode weather -City 上海

# 地缘新闻（GDELT，免费档有速率限制，失败就换 -Mode news）
pwsh -File quant-advisor-preset\macro-feed.ps1 -Mode gdelt -Query "oil price"
```

**实测输出（2026-10-20 21:50 跑的真实返回）**：

```
── 东财 7x24 快讯（4 条，政策/舆情主源）
2026-10-20 21:50:15  美股AI算力租赁商Nebius股价下跌5%
            美股AI算力租赁商Nebius股价下跌5%，短暂触及近三个月低点。
            关联：90.BK1365,90.BK0800
2026-10-20 21:44:36  纳斯达克100指数下跌1%
2026-10-20 21:42:01  费城半导体指数跌幅扩大至2%

── 全球地震（M >= 5，近 24h，USGS）
  M6.3  10-20 12:20  197 km NW of Port-Olry, Vanuatu  深16km
  M5.1  10-20 14:41  263 km WSW of Yanglong, China  深10km

── 上海 天气（Open-Meteo）
  现在 22.1°C  湿度94%  降水0.3mm  风速9.4km/h  代码55
  2026-10-21  15.4~21.8°C  降水4.7mm  最大风18.2km/h
```

### 灾情怎么用（不看震级，看产业链）

| 事件 | 传导链 |
|---|---|
| 瓦努阿图 / 智利 / 秘鲁地震 | 铜、锂矿供给 → 铜价、锂价、有色板块 |
| 台湾 / 日本东北地震 | 半导体、面板、被动元件 → 消费电子涨价预期 |
| 澳洲极端天气 | 铁矿石、锂精矿 → 钢铁成本 |
| 台风登陆 | 港口停运、航运涨价 → 集运指数、电力设备 |
| 高温 / 寒潮 | 空调电力 / 天然气煤炭 → 公用事业、能源 |
| 干旱 | 水电出力、农业减产 → 电力、农产品 |

**热搜（`-Mode hot`）** 走第三方聚合站，经常 429 限流——拿不到就跳过，它不是核心数据，不值得耗轮次。

**GDELT** 免费档有速率限制，连续调用会 429，脚本已内置 3 次退避重试；仍失败就用 `-Mode news` 或 `web_search` 替代。

---

## 五、免费源到底通不通（逐个实测过）

| 源 | 状态 | 覆盖 | 实测/备注 |
|---|---|---|---|
| 腾讯 `qt.gtimg.cn` | ✅ 在用 | A股、指数 | market-watch 插件的 `quote`/`chart`；也是脚本的回退源 |
| CoinGecko | ✅ 在用 | 加密 | 免费档限流，插件已设 1200ms 间隔 |
| **东方财富 push2** | ✅ 已接通 | A股实时/五档/资金流/板块榜（496 个板块） | 免费无 key，需带 `Referer: quote.eastmoney.com`；价格字段要 ÷100，板块榜必须 `fltt=2&invt=2` |
| **Yahoo Finance chart** | ✅ 已接通 | 港股/美股/全球指数/加密/外汇 | 免费无 key；`^GSPC` 必须编码成 `%5EGSPC`；不需要 yfinance 包，直接 HTTP 就够 |
| 新浪 `hq.sinajs.cn` | ✅ 可用（备用） | A股 | 返回 GB18030，需 `Referer: finance.sina.com.cn` |
| 东财 `push2his` K线 | ✅ 已接通 | A股日K（前复权 `fqt=1`） | `klt=101` 日线 |
| **东财 7x24 快讯** | ✅ 已接通 | 政策 / 突发 / 舆情 | `biz=web_724&fastColumn=102`（参数写错就返回空数组）；带 `stockList` 关联板块与美股代码 |
| **东财 suggest** | ✅ 已接通 | 中文名/拼音 → 代码 | `searchapi.eastmoney.com/api/suggest/get`，`茅台`→`600519`，连港股 `03750` 一起给 |
| **USGS 地震** | ✅ 已接通 | 全球地震（灾情） | GeoJSON，`all_day` / `4.5_day` 两档，免费无 key 无限制 |
| **Open-Meteo** | ✅ 已接通 | 全球天气/预报 | 需先 geocoding 转坐标；中文城市名可直接传 |
| **华尔街见闻 RSS** | ✅ 已接通 | 财经新闻 | `dedicated.wallstreetcn.com/rss.xml`，53 条/次 |
| **Bloomberg RSS** | ✅ 已接通 | 全球市场新闻 | `feeds.bloomberg.com/markets/news.rss` |
| 新浪 RSS 财经 | ❌ 已死 | —— | `rss.sina.com.cn/finance/rollnews.xml` 最新条目停在 2008 年，已从脚本移除 |
| **OKX / Binance** | ✅ 已接通 | 加密（多源容错） | `okx.com/api/v5/market/ticker?instId=BTC-USDT`，比 CoinGecko 限流宽松 |
| **GDELT** | ⚠️ 限流 | 全球新闻 / 地缘 | 免费但有速率限制，脚本内置退避重试，失败降级到 RSS |
| OpenSky 航班 | ❌ SSL 失败 | 航班 / 地缘 | 本机 TLS 握手不过（代理问题），暂不可用 |
| 60s 热搜聚合 | ❌ 429 | 微博/百度/知乎/抖音 | 免费但限流极严，多次重试仍 429，已标为可选 |
| akshare（Python） | ❌ 缺依赖 | A股全量财务/股东/宏观 | 本机 `pandas` 都没装，`cn-financial-scraper` 的 akshare 适配器跑不动 |
| yfinance（Python） | ❌ 缺依赖 | 同 Yahoo | **不需要装**——上面的 HTTP 直连已经覆盖 |
| stock-x 宿主路由 `/dsh-plugin-stock-x/*` | ⛔ 403 | —— | 只给浏览器面板用；模型侧 Invoke-RestMethod 拿不到（加 UA/Referer/Origin 都无效） |

**结论**：A股、港股、美股、全球指数、加密、板块、资金流、日K —— 免费源已经**全部接通**，零 key、零 Python。真正还缺的是「A股财务三表全量 / 股东户数 / 龙虎榜明细 / 宏观序列」这类深水数据，需要 akshare 或 Tushare，见下一节。

---

## 六、还缺什么，怎么补

### 1. 零成本开关：换 A股 dataplane

`@dshtrading/cn` 插了 7 个 dataplane，全部注册同一个 cordis 服务名，**同一时间只能启用一个**：

| 行 id | 连接器 | 状态 |
|---|---|---|
| `dsh-trading-cn-dataplane` | 腾讯 | **在用** |
| `dsh-trading-cn-dataplane-eastmoney` | 东方财富 | disabled |
| `dsh-trading-cn-dataplane-tushare` | Tushare | disabled（要 token） |
| `dsh-trading-cn-dataplane-akshare` | AKShare | disabled（要本地 Python 依赖） |
| `dsh-trading-cn-dataplane-qmt` | QMT / 迅投 | disabled（要客户端） |
| `dsh-trading-cn-dataplane-hithink` | 同花顺 | **未禁用**——和腾讯抢同一服务名，启动日志里那条 `service "tradingCnMarketData" has been registered` 就是它；想彻底消掉就补一行 `- id: dsh-trading-cn-dataplane-hithink` + `disabled: true` |
| `dsh-trading-cn-dataplane-xysz` | 银河星耀 `:8191` | disabled（要本地 FastAPI 服务） |

换源方法：给想用的那行删掉 `disabled: true`，同时给 `dsh-trading-cn-dataplane`（腾讯）加 `disabled: true`，重启 DSH。一次只能留一个。

### 2. 装 Python 依赖（解锁 akshare 全量）

```powershell
pip install akshare yfinance pandas
```
装完 `cn-financial-scraper` 技能的 akshare/yfinance 适配器才能用（财务三表、股东、龙虎榜、宏观序列、机构名单批量拉取）。

### 3. 要 key 的（按性价比排序）

| 缺口 | 补什么 | 解锁 | 没有时的降级 |
|---|---|---|---|
| A股财务/股东/龙虎榜/宏观全量 | **Tushare Pro token** | tushare dataplane + 全量财报 | akshare 免费替代 |
| 美国宏观（利率/通胀/就业） | **FRED API key** | 美债、CPI、失业率原始序列 | `web_search` 查最新值 |
| 美股深度（财报细节、期权、内幕） | **Finnhub** 或 **Polygon** | 美股基本面与事件 | Yahoo chart + `yahoo-finance-cli` 专家 |
| 加密不限流 | **CoinGecko Pro** | 高频多标的、长历史 | 免费档（现配 1200ms 间隔） |
| 快讯/公告秒级 | 财联社/新闻 API | 消息驱动策略 | `web_search` + `cn-financial-scraper` 舆情 |
| Level-2 / 逐笔 | 券商终端（QMT / 同花顺） | 盘口、逐笔成交 | 只有五档与延迟报价 |

缺哪条直接说「补 Tushare token」，主窗口会告诉你写到哪个环境变量；没有也能跑，人设里写好了降级链。

---

## 七、常用指令（直接抄）

```
盘前简报                      → 隔夜美股+加密+A50、今日数据与政策日历、昨日涨停梯队、三条主线两条风险
为什么茅台今天涨              → 资金→消息→板块联动→技术位 四步取证，每步带来源与时间戳
复盘今天                      → 指数/成交额、板块强弱、主力净流入前后、涨跌停与炸板率、明日关键位
/trading-agent 600519         → 14 角色 A股管线（数分钟），报告落 ~/.dsh/tradingagents/reports/
查一下 600519 的资金流         → market-feed.ps1 600519 -Mode flow
今天板块谁最强                 → market-feed.ps1 -Mode sectors -Top 10
把 600519、NVDA、BTC 做成对比  → 三次 detail + 一张表（univer Sheet）
给我一个 BTC 突破 10 万美金的提醒 → watch + alert（changePercent/price）
每天 8:30 给我盘前简报        → proactive_set cron "30 8 * * 1-5"
用 2020-2025 数据回测「20 日新高买入、ATR 2 倍止损」 → 量化席出脚本 + 指标 + 失效条件
```

盯盘与提醒三层机制（人设里已写死）：
- `watch` 建自选 → `alert` 建阈值（`changePercent` 超 3%、`price` 上破/下破，冷却 300 秒）；
- `proactive_set` 定时唤醒自己（cron 五字段，如 `0 9-15/1 * * 1-5`；`every_seconds` 最小 300）；
- market-watch 现配 30 秒轮询，触发后按 `agentWakeup: true` 以跟进回合唤醒会话。

---

## 八、它不会做什么

- 不下单、不接券商交易接口。要下单时只输出「下单清单」（标的/方向/价位/数量/止损）。
- 不编数字。查不到就说「未取到」，延迟数据必须标延迟。
- 不承诺收益。结论后面固定一行风险提示，不重复说教。

---

## 九、改这个预设

人设（七席、数据路由、SOP、纪律）全在 `cordis.patch.yml` 的 `persona.config.prefix` 里，是一段 5600 多字的 YAML 块标量。改完：

1. 把整块重新合并进 `C:\Users\lt\.dsh\profiles\desktop\cordis.patch.yml`（或直接编辑那一行）；
2. 重启 DSH；
3. **开新会话**验证（老会话保留启动时的提示词）。

改插件行要谨慎：某个包名解析不到，整个 preset 会 broken、模式卡片直接消失。安全的做法是只动 `plugins` 里已存在的行，加行前先确认包在当前 profile 的 `node_modules` 里。
