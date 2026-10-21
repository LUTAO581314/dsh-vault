<#
  market-feed.ps1 — 零依赖多市场取数（腾讯 / 东方财富 / Yahoo Finance / CoinGecko）
  全部免费、无需 API key、不需要 Python。

  用法：
    pwsh -File market-feed.ps1 600519,sh000001,NVDA,0700.HK,^GSPC,BTC-USD
    pwsh -File market-feed.ps1 600519 -Mode detail          # 含五档/估值/换手
    pwsh -File market-feed.ps1 600519 -Mode flow -Days 5    # 主力资金流
    pwsh -File market-feed.ps1 -Mode sectors -Top 10        # 板块涨幅榜
    pwsh -File market-feed.ps1 NVDA -Mode kline -Days 30    # K线序列
    pwsh -File market-feed.ps1 600519 -Json                 # 机器可读

  路由：
    A股个股/指数（6 位数字，或 sh/sz/bj 前缀）→ 东方财富 push2（失败回退腾讯）
    港股 / 美股 / 全球指数 / 加密 → Yahoo Finance chart
    -Mode sectors 固定走东方财富板块榜
#>
[CmdletBinding()]
param(
  [string[]]$Symbols = @(),
  [ValidateSet('quote','detail','flow','sectors','kline','rank','board','lookup')]
  [string]$Mode = 'quote',
  [ValidateSet('gain','loss','amount')]
  [string]$RankType = 'gain',
  [ValidateSet('industry','concept')]
  [string]$BoardType = 'industry',
  [string]$Query = '',
  [int]$Days = 20,
  [int]$Top = 10,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
$HDR = @{ 'User-Agent' = $UA; 'Referer' = 'https://quote.eastmoney.com/' }
$YHDR = @{ 'User-Agent' = $UA; 'Accept' = 'application/json' }
$out = [System.Collections.Generic.List[object]]::new()
$notes = [System.Collections.Generic.List[string]]::new()

function Invoke-Json([string]$Url, [hashtable]$Headers) {
  try { return Invoke-RestMethod -Uri $Url -Headers $Headers -TimeoutSec 20 }
  catch { return $null }
}

# ---------- 符号路由 ----------
function Resolve-Market([string]$s) {
  $t = $s.Trim()
  if ($t -match '^(sh|sz|bj)(\d{6})$') { return @{ kind='cn'; code=$Matches[2]; ex=$Matches[1] } }
  if ($t -match '^\d{6}$') {
    $ex = if ($t -match '^(6|9)') { 'sh' } elseif ($t -match '^(0|3)') { 'sz' } else { 'bj' }
    return @{ kind='cn'; code=$t; ex=$ex }
  }
  if ($t -match '^(\d{4,5})\.HK$') { return @{ kind='yahoo'; sym=('{0}.HK' -f $Matches[1].PadLeft(4,'0')) } }
  if ($t -match '^\d{4,5}$')        { return @{ kind='yahoo'; sym=('{0}.HK' -f $t.PadLeft(4,'0')) } }
  if ($t -match '^\^')              { return @{ kind='yahoo'; sym=[uri]::EscapeDataString($t) } }
  return @{ kind='yahoo'; sym=$t }
}

function Get-EmSecid([string]$code, [string]$ex) {
  $pre = switch ($ex) { 'sh' { '1' } 'sz' { '0' } 'bj' { '0' } default { if ($code -match '^(6|9)') {'1'} else {'0'} } }
  # 指数修正
  if ($code -eq '000001' -and $ex -eq 'sh') { return '1.000001' }
  return "$pre.$code"
}

# ---------- 东方财富：报价 ----------
function Get-CnQuote([string]$code, [string]$ex) {
  $secid = Get-EmSecid $code $ex
  $f = 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170,f116,f117,f162,f168,f171,f50,f86'
  $r = Invoke-Json "https://push2.eastmoney.com/api/qt/stock/get?secid=$secid&fields=$f" $HDR
  if (-not $r -or -not $r.data -or $null -eq $r.data.f43) { return $null }
  $d = $r.data
  return [pscustomobject]@{
    symbol    = $code
    name      = $d.f58
    market    = 'CN'
    last      = [math]::Round($d.f43 / 100, 2)
    changePct = [math]::Round($d.f170 / 100, 2)
    change    = [math]::Round($d.f169 / 100, 2)
    prevClose = [math]::Round($d.f60 / 100, 2)
    open      = [math]::Round($d.f46 / 100, 2)
    high      = [math]::Round($d.f44 / 100, 2)
    low       = [math]::Round($d.f45 / 100, 2)
    volume    = $d.f47                                    # 手
    amount    = [math]::Round($d.f48 / 1e8, 2)            # 亿元
    turnover  = [math]::Round($d.f168 / 100, 2)           # %
    pe        = $( if ($d.f162 -and $d.f162 -ne '-') { [math]::Round($d.f162 / 100, 2) } else { $null } )
    mktCapYi  = $( if ($d.f116) { [math]::Round($d.f116 / 1e8, 0) } else { $null } )
    currency  = 'CNY'
    src       = 'eastmoney'
    ts        = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  }
}

# ---------- Yahoo：报价 ----------
function Get-YahooQuote([string]$sym) {
  $u = "https://query1.finance.yahoo.com/v8/finance/chart/$sym" + '?range=5d&interval=1d'
  $r = Invoke-Json $u $YHDR
  if (-not $r -or -not $r.chart -or -not $r.chart.result) { return $null }
  $res = $r.chart.result[0]
  $m = $res.meta
  $last = $m.regularMarketPrice
  $prev = $( if ($m.chartPreviousClose) { $m.chartPreviousClose } else { $m.previousClose } )
  $chg  = $( if ($last -and $prev) { [math]::Round($last - $prev, 4) } else { $null } )
  $pct  = $( if ($chg -and $prev) { [math]::Round(100 * $chg / $prev, 2) } else { $null } )
  return [pscustomobject]@{
    symbol    = ($sym -replace '%5E','^')
    name      = $( if ($m.shortName) { $m.shortName } else { $m.symbol } )
    market    = $( if ($sym -match '\.HK') { 'HK' } elseif ($sym -match '\.(SS|SZ)$') { 'CN' } elseif ($sym -match '-USD$') { 'CRYPTO' } else { 'US' } )
    last      = $last
    changePct = $pct
    change    = $chg
    prevClose = $prev
    open      = $m.regularMarketOpen
    high      = $m.regularMarketDayHigh
    low       = $m.regularMarketDayLow
    volume    = $m.regularMarketVolume
    amount    = $null
    turnover  = $null
    pe        = $null
    mktCapYi  = $null
    currency  = $m.currency
    src       = 'yahoo'
    ts        = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  }
}

# ---------- 腾讯回退 ----------
function Get-TxQuote([string]$code, [string]$ex) {
  $sym = "$ex$code"
  try {
    $r = Invoke-WebRequest -Uri "https://qt.gtimg.cn/q=$sym" -Headers @{ 'User-Agent'=$UA; 'Referer'='https://gu.qq.com/' } -TimeoutSec 12 -UseBasicParsing
    $txt = [System.Text.Encoding]::GetEncoding('GB18030').GetString($r.RawContentStream.ToArray())
    $p = ($txt -split '"')[1] -split '~'
    return [pscustomobject]@{
      symbol=$code; name=$p[1]; market='CN'; last=[double]$p[3]; changePct=[double]$p[32]; change=[double]$p[31]
      prevClose=[double]$p[4]; open=[double]$p[5]; high=[double]$p[33]; low=[double]$p[34]
      volume=[double]$p[6]; amount=$null; turnover=$null; pe=$null; mktCapYi=$null
      currency='CNY'; src='tencent'; ts=$p[30]
    }
  } catch { return $null }
}

# ---------- 东财：资金流 ----------
function Get-CnFlow([string]$code, [string]$ex) {
  $secid = Get-EmSecid $code $ex
  $u = "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?secid=$secid&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56&klt=101&lmt=$Days"
  $r = Invoke-Json $u $HDR
  if (-not $r -or -not $r.data -or -not $r.data.klines) { return @() }
  return $r.data.klines | ForEach-Object {
    $c = $_ -split ','
    [pscustomobject]@{
      date        = $c[0]
      mainNetYi   = [math]::Round([double]$c[1] / 1e8, 3)   # 主力净额 亿
      smallNetYi  = [math]::Round([double]$c[2] / 1e8, 3)
      midNetYi    = [math]::Round([double]$c[3] / 1e8, 3)
      bigNetYi    = [math]::Round([double]$c[4] / 1e8, 3)
      hugeNetYi   = [math]::Round([double]$c[5] / 1e8, 3)
    }
  }
}

# ---------- 东财：板块榜 ----------
function Get-CnSectors([int]$n, [string]$type = 'industry') {
  $t = $( if ($type -eq 'concept') { '3' } else { '2' } )
  $u = "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=$n&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m%3A90%2Bt%3A$t&fields=f12%2Cf14%2Cf3%2Cf62%2Cf104%2Cf105%2Cf128"
  $r = Invoke-Json $u $HDR
  if (-not $r -or -not $r.data -or -not $r.data.diff) { return @() }
  return $r.data.diff | ForEach-Object {
    [pscustomobject]@{
      board   = $_.f14
      chgPct  = $_.f3
      mainNetYi = $( if ($null -ne $_.f62) { [math]::Round($_.f62 / 1e8, 2) } else { $null } )
      upCount = $_.f104
      downCount = $_.f105
      leader  = $_.f128
    }
  }
}

# ---------- 东财：K线 ----------
function Get-CnKline([string]$code, [string]$ex, [int]$n) {
  $secid = Get-EmSecid $code $ex
  $u = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=$secid&klt=101&fqt=1&lmt=$n&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58"
  $r = Invoke-Json $u $HDR
  if (-not $r -or -not $r.data -or -not $r.data.klines) { return @() }
  return $r.data.klines | ForEach-Object {
    $c = $_ -split ','
    [pscustomobject]@{ date=$c[0]; open=[double]$c[1]; close=[double]$c[2]; high=[double]$c[3]; low=[double]$c[4]; volume=[double]$c[5]; amount=[double]$c[6] }
  }
}

# ---------- Yahoo：K线 ----------
function Get-YahooKline([string]$sym, [int]$n) {
  $range = $( if ($n -le 5) {'5d'} elseif ($n -le 30) {'1mo'} elseif ($n -le 120) {'6mo'} else {'1y'} )
  $u = "https://query1.finance.yahoo.com/v8/finance/chart/$sym" + "?range=$range&interval=1d"
  $r = Invoke-Json $u $YHDR
  if (-not $r -or -not $r.chart.result) { return @() }
  $res = $r.chart.result[0]
  $ts = $res.timestamp; $q = $res.indicators.quote[0]
  if (-not $ts) { return @() }
  $rows = for ($i = 0; $i -lt $ts.Count; $i++) {
    [pscustomobject]@{
      date  = [DateTimeOffset]::FromUnixTimeSeconds($ts[$i]).ToString('yyyy-MM-dd')
      open  = $q.open[$i]; close = $q.close[$i]; high = $q.high[$i]; low = $q.low[$i]; volume = $q.volume[$i]
    }
  }
  return $rows | Select-Object -Last $n
}

# ---------- 东财：涨/跌/成交额榜 ----------
function Get-CnRank([string]$type, [int]$n) {
  $fs = 'm%3A0%2Bt%3A6%2Cm%3A0%2Bt%3A80%2Cm%3A1%2Bt%3A2%2Cm%3A1%2Bt%3A23'
  $fid = 'f3'; $po = 1
  switch ($type) {
    'gain'   { $fid = 'f3'; $po = 1 }
    'loss'   { $fid = 'f3'; $po = 0 }
    'amount' { $fid = 'f6'; $po = 1 }
  }
  $u = "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=$n&po=$po&np=1&fltt=2&invt=2&fid=$fid&fs=$fs&fields=f12%2Cf14%2Cf2%2Cf3%2Cf6%2Cf62"
  $r = Invoke-Json $u $HDR
  if (-not $r -or -not $r.data -or -not $r.data.diff) { return @() }
  return $r.data.diff | ForEach-Object {
    [pscustomobject]@{
      code      = $_.f12
      name      = $_.f14
      price     = $_.f2
      chgPct    = $_.f3
      amountYi  = $( if ($_.f6) { [math]::Round($_.f6 / 1e8, 2) } else { $null } )
      mainNetYi = $( if ($null -ne $_.f62) { [math]::Round($_.f62 / 1e8, 2) } else { $null } )
    }
  }
}

# ---------- 东财：中文名/拼音 → 代码与 secid ----------
function Resolve-CnName([string]$kw) {
  $u = "https://searchapi.eastmoney.com/api/suggest/get?input=" + [uri]::EscapeDataString($kw) + "&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8"
  $r = Invoke-Json $u @{ 'User-Agent' = $UA } 
  if (-not $r -or -not $r.QuotationCodeTable -or -not $r.QuotationCodeTable.Data) { return @() }
  return $r.QuotationCodeTable.Data | ForEach-Object {
    [pscustomobject]@{ code = $_.Code; name = $_.Name; pinyin = $_.PinYin; market = $_.SecurityTypeName; secid = $_.QuoteID; classify = $_.Classify }
  }
}

# ================= 执行 =================
if ($Mode -eq 'rank') {
  $rows = Get-CnRank $RankType $Top
  if ($Json) { $rows | ConvertTo-Json -Depth 4; return }
  if (-not $rows) { Write-Output '未取到榜单数据（东财接口异常）'; return }
  $label = switch ($RankType) { 'gain' { '涨幅榜' } 'loss' { '跌幅榜' } 'amount' { '成交额榜' } }
  Write-Output "── A股$label（前 $($rows.Count)）"
  $rows | ForEach-Object { '{0,-10} {1,-6} {2,9}  {3,7}%  成交{4,7}亿  主力{5,7}亿' -f $_.name, $_.code, $_.price, $_.chgPct, $_.amountYi, $_.mainNetYi }
  return
}

if ($Mode -eq 'board') {
  $rows = Get-CnSectors $Top $BoardType
  if ($Json) { $rows | ConvertTo-Json -Depth 4; return }
  if (-not $rows) { Write-Output '未取到板块数据'; return }
  $label = $( if ($BoardType -eq 'concept') { '概念板块' } else { '行业板块' } )
  Write-Output "── $label 涨幅榜（前 $($rows.Count)）"
  $rows | ForEach-Object { '{0,-14} {1,7}%  主力{2,7}亿  涨{3}/跌{4}  领涨 {5}' -f $_.board, $_.chgPct, $_.mainNetYi, $_.upCount, $_.downCount, $_.leader }
  return
}

if ($Mode -eq 'lookup') {
  if (-not $Query) { Write-Output '用法: -Mode lookup -Query 茅台'; return }
  $rows = Resolve-CnName $Query
  if ($Json) { $rows | ConvertTo-Json -Depth 4; return }
  if (-not $rows) { Write-Output "未匹配到「$Query」"; return }
  Write-Output "── 「$Query」匹配结果（可直接喂给 -Symbols 或 -Mode detail）"
  $rows | ForEach-Object { '{0,-8} {1,-12} {2,-8} {3,-6} secid={4}' -f $_.code, $_.name, $_.pinyin, $_.market, $_.secid }
  return
}

if ($Mode -eq 'sectors') {
  $rows = Get-CnSectors $Top
  if ($Json) { $rows | ConvertTo-Json -Depth 4; return }
  if (-not $rows) { Write-Output '未取到板块数据（东财接口异常）'; return }
  $rows | ForEach-Object { '{0,-12} {1,7}%  主力{2,7}亿  涨{3}/跌{4}  领涨 {5}' -f $_.board, $_.chgPct, $_.mainNetYi, $_.upCount, $_.downCount, $_.leader }
  return
}

if (-not $Symbols -or $Symbols.Count -eq 0) { Write-Output '用法: market-feed.ps1 600519,NVDA,^GSPC,BTC-USD [-Mode quote|detail|flow|sectors|kline]'; return }

foreach ($raw in ($Symbols -join ',').Split(',') | Where-Object { $_.Trim() }) {
  $m = Resolve-Market $raw
  try {
    if ($Mode -eq 'flow') {
      if ($m.kind -ne 'cn') { $notes.Add("${raw}: 资金流仅支持 A 股"); continue }
      $rows = Get-CnFlow $m.code $m.ex
      if ($Json) { $out.Add([pscustomobject]@{ symbol=$raw; flow=$rows }) }
      else {
        Write-Output "── $raw 主力资金流（最近 $($rows.Count) 日，单位亿元）"
        $rows | ForEach-Object { '  {0}  主力{1,8}  超大单{2,8}  大单{3,8}  中单{4,8}  小单{5,8}' -f $_.date,$_.mainNetYi,$_.hugeNetYi,$_.bigNetYi,$_.midNetYi,$_.smallNetYi }
      }
      continue
    }
    if ($Mode -eq 'kline') {
      $rows = if ($m.kind -eq 'cn') { Get-CnKline $m.code $m.ex $Days } else { Get-YahooKline $m.sym $Days }
      if ($Json) { $out.Add([pscustomobject]@{ symbol=$raw; kline=$rows }) }
      else {
        Write-Output "── $raw 日K（最近 $($rows.Count) 根，前复权）"
        $rows | ForEach-Object { '  {0}  O {1,9}  C {2,9}  H {3,9}  L {4,9}' -f $_.date,$_.open,$_.close,$_.high,$_.low }
      }
      continue
    }
    # quote / detail
    $q = if ($m.kind -eq 'cn') {
      $x = Get-CnQuote $m.code $m.ex
      if (-not $x) { $x = Get-TxQuote $m.code $m.ex; if ($x) { $notes.Add("$raw 东财失败，已回退腾讯") } }
      $x
    } else { Get-YahooQuote $m.sym }
    if (-not $q) { $notes.Add("${raw}: 未取到数据"); continue }
    if ($Json) { $out.Add($q); continue }
    '{0,-10} {1,-14} {2,10} {3,8}%  {4} {5}' -f $q.symbol, $q.name, $q.last, $q.changePct, $q.currency, "($($q.src))"
    if ($Mode -eq 'detail') {
      '           开 {0}  高 {1}  低 {2}  昨收 {3}' -f $q.open, $q.high, $q.low, $q.prevClose
      '           量 {0}  额 {1}亿  换手 {2}%  PE {3}  总市值 {4}亿' -f $q.volume, $q.amount, $q.turnover, $q.pe, $q.mktCapYi
    }
  } catch { $notes.Add("${raw}: $($_.Exception.Message)") }
}

if ($Json) { $out | ConvertTo-Json -Depth 6; return }
$notes | ForEach-Object { "  ! $_" }
Write-Output "来源：东方财富 / Yahoo Finance / 腾讯（均为免费公开接口，可能延迟数秒至数分钟，不构成投资建议）"
