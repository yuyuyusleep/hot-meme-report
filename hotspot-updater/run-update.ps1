# run-update.ps1
# 热点日报自动更新总控脚本
# 供 CatDesk 定时自动化任务调用

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogFile = Join-Path $ScriptDir "update.log"
$NodeExe = "node"

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

Log "========== 热点日报自动更新开始 =========="

# Step 0: 浏览器抓取小红书热搜（写入 xhs-data.json）
Log "Step 0: 浏览器抓取小红书热搜..."
try {
    & $NodeExe "$ScriptDir\fetch-xhs-browser.js" 2>&1 | ForEach-Object { Log $_ }
    if ($LASTEXITCODE -ne 0) {
        Log "Step 0 警告: 小红书抓取失败（退出码 $LASTEXITCODE），继续执行后续步骤"
    } else {
        Log "Step 0 完成"
    }
} catch {
    Log "Step 0 警告: $_（继续执行）"
}

# Step 1: 抓取热榜数据
Log "Step 1: 抓取热榜数据..."
try {
    & $NodeExe "$ScriptDir\fetch-hotspot.js" 2>&1 | ForEach-Object { Log $_ }
    if ($LASTEXITCODE -ne 0) { throw "fetch-hotspot.js 退出码: $LASTEXITCODE" }
    Log "Step 1 完成"
} catch {
    Log "Step 1 失败: $_"
    exit 1
}

# Step 1.5 & 1.6: 监控博主和账号数据
# 说明：viral-data.json 和 own-data.json 为手动维护文件，每周更新一次即可
# 自动抓取功能暂不启用（小红书需登录态，browser-action 不适用）
Log "Step 1.5: 监控博主数据使用 viral-data.json（手动维护）"
Log "Step 1.6: 账号数据使用 own-data.json（手动维护）"

# Step 2: AI 分析 + 更新 HTML
Log "Step 2: AI 分析并更新 HTML..."
try {
    & $NodeExe "$ScriptDir\update-html.js" 2>&1 | ForEach-Object { Log $_ }
    if ($LASTEXITCODE -ne 0) { throw "update-html.js 退出码: $LASTEXITCODE" }
    Log "Step 2 完成"
} catch {
    Log "Step 2 失败: $_"
    exit 1
}

# Step 3: 推送到 GitHub
Log "Step 3: 推送到 GitHub..."
try {
    & $NodeExe "$ScriptDir\push-github.js" 2>&1 | ForEach-Object { Log $_ }
    if ($LASTEXITCODE -ne 0) { throw "push-github.js 退出码: $LASTEXITCODE" }
    Log "Step 3 完成"
} catch {
    Log "Step 3 失败: $_"
    exit 1
}

Log "========== 热点日报自动更新完成 =========="
