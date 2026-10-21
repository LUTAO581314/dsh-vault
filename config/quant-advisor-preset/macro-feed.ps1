<#
  macro-feed.ps1 — 零依赖「事件与灾情」取数（全部免费、无 key、不需要 Python）
  覆盖：财经快讯（政策/舆情）· 多源财经新闻 RSS · 全球地震 · 全球天气 · 地缘新闻 · 热搜

  用法：
    pwsh -File macro-feed.ps1                           # 东财 7x24 快讯（最新 10 条）
    pwsh -File macro-feed.ps1 -Mode flash -Limit 20 -Filter 降准
    pwsh -File macro-feed.ps1 -Mode news -Filter 关税    # 华尔街见闻+新浪+Bloomberg 过滤
    pwsh -File macro-feed.ps1 -Mode quake -MinMag 5     # 近 24h 全球 >=5 级地震
    pwsh -File macro-feed.ps1 -Mode weather -City 上海
    pwsh -File macro-feed.ps1 -Mode gdelt -Query "semiconductor"
    pwsh -File macro-feed.ps1 -Mode hot                 # 热搜（第三方聚合，可能限流）
    pwsh -File macro-feed.ps1 -Mode flash -Json
#>
[CmdletBinding()]
param(
  [ValidateSet('flash','news','quake','weather','gdelt','hot')]
  [string]$Mode = 'flash',
  [string]$Filter = '',
  [string]$Query = '',
  [string]$City = '北京',
  [double]$Lat = 39.9042,
  [double]$Lon = 116.4074,
  [double]$MinMag = 4.5,
  [int]$Limit = 10,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
$H  = @{ 'User-Agent' = $UA }

function Get-Resp([string]$Url, [hashtable]$Headers) {
  return Invoke-WebRequest -Uri $Url -Headers $Headers -TimeoutSec 30 -UseBasicParsing
}

# 自动识别编码（GBK / UTF-8），避免中文乱码
function Get-TextSmart($Resp) {
  $bytes = $Resp.RawContentStream.ToArray()
  $head  = [System.Text.Encoding]::ASCII.GetString($bytes[0..([Math]::Min(400,$bytes.Length-1))])
  if ($head -match 'encoding=["'']?(gb2312|gbk|gb18030)') {
    return [System.Text.Encoding]::GetEncoding('GB18030').GetString($bytes)
  }
  if ($head -match 'charset=["'']?(gb2312|gbk|gb18030)') {
    return [System.Text.Encoding]::GetEncoding('GB18030').GetString($bytes)
  }
  return [System.Text.Encoding]::UTF8.GetString($bytes)
}

function Get-Prop($obj, [string]$name) {
  if (-not $obj) { return $null }
  if ($obj -is [string]) { return $obj }
  $p = $obj.$name
  if ($null -eq $p) { return $null }
  if ($p -is [string]) { return $p }
  if ($p.InnerText) { return $p.InnerText }
  if ($p.'#text')   { return $p.'#text' }
  return [string]$p
}

function Get-Rss([string]$Url, [string]$Src, [int]$n) {
  try {
    $resp = Get-Resp $Url $H
    $xml  = [xml](Get-TextSmart $resp)
    $items = $xml.rss.channel.item
    if (-not $items) { $items = $xml.feed.entry }
    if (-not $items) { return @() }
    return $items | Select-Object -First $n | ForEach-Object {
      $t = Get-Prop $_ 'title'
      $d = Get-Prop $_ 'pubDate'
      if (-not $d) { $d = Get-Prop $_ 'updated' }
      $l = $null
      if ($_.link -is [string]) { $l = $_.link } elseif ($_.link) { $l = Get-Prop $_ 'link' }
      [pscustomobject]@{ src = $Src; date = $d; title = $t; link = $l }
    }
  } catch { return @() }
}

# ---------- 1. 东财 7x24 快讯（政策信号 / 舆情主源） ----------
function Get-Flash([int]$n, [string]$kw) {
  $u = "https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=$n&req_trace=1"
  $r = Invoke-RestMethod -Uri $u -Headers $H -TimeoutSec 25
  if (-not $r.data -or -not $r.data.fastNewsList) { return @() }
  $rows = $r.data.fastNewsList | ForEach-Object {
    [pscustomobject]@{
      time   = $_.showTime
      title  = $_.title
      digest = $_.summary
      stocks = ($_.stockList -join ',')
    }
  }
  if ($kw) { $rows = $rows | Where-Object { $_.title -match $kw -or $_.digest -match $kw } }
  return $rows
}

# ---------- 2. 多源财经新闻 RSS ----------
function Get-News([string]$kw, [int]$n) {
  $srcs = @(
    @{ u = 'https://dedicated.wallstreetcn.com/rss.xml';   s = '华尔街见闻' },
    @{ u = 'https://feeds.bloomberg.com/markets/news.rss'; s = 'Bloomberg'  }
  )
  $all = @()
  foreach ($s in $srcs) { $all += Get-Rss $s.u $s.s $n }
  if ($kw) { $all = $all | Where-Object { $_.title -match $kw } }
  return $all
}

# ---------- 3. 全球地震（USGS） ----------
function Get-Quake([double]$minMag) {
  $u = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson'
  $r = Invoke-RestMethod -Uri $u -Headers $H -TimeoutSec 25
  if (-not $r.features) { return @() }
  return $r.features |
    Where-Object { $_.properties.mag -ge $minMag } |
    Sort-Object { $_.properties.time } -Descending |
    ForEach-Object {
      [pscustomobject]@{
        time  = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$_.properties.time).ToLocalTime().ToString('MM-dd HH:mm')
        mag   = $_.properties.mag
        place = $_.properties.place
        depth = [math]::Round($_.geometry.coordinates[2], 1)
        url   = $_.properties.url
      }
    }
}

# ---------- 4. 全球天气（Open-Meteo） ----------
function Get-Wea([string]$city) {
  if ($city) {
    $g = Invoke-RestMethod -Uri ("https://geocoding-api.open-meteo.com/v1/search?name=" + [uri]::EscapeDataString($city) + "&count=1&language=zh") -Headers $H -TimeoutSec 20
    if ($g.results -and $g.results.Count -gt 0) {
      $script:Lat = $g.results[0].latitude; $script:Lon = $g.results[0].longitude
      $script:City = $g.results[0].name
    }
  }
  $u = "https://api.open-meteo.com/v1/forecast?latitude=$Lat&longitude=$Lon&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&timezone=Asia%2FShanghai&forecast_days=3"
  $r = Invoke-RestMethod -Uri $u -Headers $H -TimeoutSec 25
  return [pscustomobject]@{
    city    = $City
    nowTemp = $r.current.temperature_2m
    humidity= $r.current.relative_humidity_2m
    rain    = $r.current.precipitation
    wind    = $r.current.wind_speed_10m
    code    = $r.current.weather_code
    days    = for ($i = 0; $i -lt $r.daily.time.Count; $i++) {
      [pscustomobject]@{
        date = $r.daily.time[$i]; max = $r.daily.temperature_2m_max[$i]; min = $r.daily.temperature_2m_min[$i]
        rain = $r.daily.precipitation_sum[$i]; wind = $r.daily.wind_speed_10m_max[$i]
      }
    }
  }
}

# ---------- 5. GDELT 地缘新闻 ----------
function Get-Gdelt([string]$q, [int]$n) {
  if (-not $q) { $q = 'finance' }
  $u = 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + [uri]::EscapeDataString($q) + "&mode=artlist&format=json&maxrecords=$n&sort=datedesc"
  for ($i = 0; $i -lt 3; $i++) {
    try {
      $r = Invoke-RestMethod -Uri $u -Headers $H -TimeoutSec 30
      if ($r.articles) {
        return $r.articles | ForEach-Object {
          [pscustomobject]@{ date = $_.seendate; domain = $_.domain; title = $_.title; url = $_.url }
        }
      }
      return @()
    } catch {
      if ($i -eq 2) { throw "GDELT 限流（免费档有速率限制），稍后重试或改用 -Mode news" }
      Start-Sleep -Seconds (3 * ($i + 1))
    }
  }
}

# ---------- 6. 热搜（第三方聚合，可能限流） ----------
function Get-Hot([int]$n) {
  $out = @()
  foreach ($p in @(@{k='weibo';l='微博'}, @{k='baidu/hot';l='百度'}, @{k='zhihu';l='知乎'}, @{k='douyin';l='抖音'})) {
    try {
      $r = Invoke-RestMethod -Uri ("https://60s.viki.moe/v2/" + $p.k) -Headers $H -TimeoutSec 15
      $list = $r.data
      if ($list) {
        $out += $list | Select-Object -First $n | ForEach-Object {
          [pscustomobject]@{ platform = $p.l; title = $(if ($_.title) { $_.title } else { $_.word }); hot = $(if ($_.hot) { $_.hot } else { $_.hotScore }) }
        }
      }
    } catch { continue }
  }
  return $out
}

# ================= 执行 =================
$data = $null
try {
  switch ($Mode) {
    'flash'   { $data = Get-Flash $Limit $Filter }
    'news'    { $data = Get-News $Filter $Limit }
    'quake'   { $data = Get-Quake $MinMag | Select-Object -First $Limit }
    'weather' { $data = Get-Wea $City }
    'gdelt'   { $data = Get-Gdelt $Query $Limit }
    'hot'     { $data = Get-Hot $Limit }
  }
} catch { $data = $null; $err = $_.Exception.Message }

if ($Json) { $data | ConvertTo-Json -Depth 5; return }
if (-not $data) {
  if ($err) { Write-Output "未取到数据：$err" } else { Write-Output '未取到数据（接口返回空或无匹配）' }
  return
}

switch ($Mode) {
  'flash' {
    Write-Output "── 东财 7x24 快讯（$($data.Count) 条，政策/舆情主源）"
    $data | ForEach-Object {
      Write-Output "$($_.time)  $($_.title)"
      if ($_.digest -and $_.digest -ne $_.title) {
        $d = $_.digest -replace '\s+',' '
        if ($d.Length -gt 150) { $d = $d.Substring(0,150) + '…' }
        Write-Output "            $d"
      }
      if ($_.stocks) { Write-Output "            关联：$($_.stocks)" }
    }
  }
  'news' {
    Write-Output "── 财经新闻（$($data.Count) 条，华尔街见闻 / Bloomberg）"
    $data | ForEach-Object { Write-Output "[$($_.src)] $($_.date)  $($_.title)" }
  }
  'quake' {
    Write-Output "── 全球地震（M >= $MinMag，近 24h，USGS）"
    $data | ForEach-Object { Write-Output "  M$($_.mag)  $($_.time)  $($_.place)  深$($_.depth)km" }
  }
  'weather' {
    $d = $data
    Write-Output "── $($d.city) 天气（Open-Meteo）"
    Write-Output "  现在 $($d.nowTemp)°C  湿度$($d.humidity)%  降水$($d.rain)mm  风速$($d.wind)km/h  代码$($d.code)"
    $d.days | ForEach-Object { Write-Output "  $($_.date)  $($_.min)~$($_.max)°C  降水$($_.rain)mm  最大风$($_.wind)km/h" }
  }
  'gdelt' {
    Write-Output "── GDELT 全球新闻（$($data.Count) 条）"
    $data | ForEach-Object { Write-Output "  $($_.date) [$($_.domain)] $($_.title)" }
  }
  'hot' {
    if ($data.Count -eq 0) { Write-Output '未取到热搜（第三方聚合站限流 429），可改用 -Mode flash 看财经快讯' ; return }
    Write-Output "── 热搜（$($data.Count) 条）"
    $data | ForEach-Object { Write-Output "  [$($_.platform)] $($_.title)" }
  }
}
Write-Output ''
Write-Output '来源：东方财富 / USGS / Open-Meteo / GDELT / RSS（免费公开接口，快讯为准实时，其余有分钟级延迟）'
