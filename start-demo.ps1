param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDirectory = Join-Path $projectRoot "BE"
$notificationDirectory = Join-Path $backendDirectory "notify"
$aiDirectory = Join-Path $projectRoot "AI"
$frontendDirectory = Join-Path $projectRoot "FE"
$runtimeDirectory = Join-Path $backendDirectory "build\demo"
$logDirectory = Join-Path $runtimeDirectory "logs"
$backendPort = 8080
$aiPort = 5001
$notificationPort = 3001
$frontendPort = 5173

New-Item -ItemType Directory -Force -Path $runtimeDirectory, $logDirectory | Out-Null

function Test-LocalPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connect = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(500)) {
            return $false
        }
        $client.EndConnect($connect)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function Get-Health([string]$Url) {
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.HttpWebRequest]::Create($Url)
        $request.Proxy = $null
        $request.Timeout = 3000
        $request.ReadWriteTimeout = 3000
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        $body = $reader.ReadToEnd()
        if ($response.ContentType -match "application/json") {
            return ConvertFrom-Json $body
        }
        return [pscustomobject]@{
            reachable = $true
            isFrontendHtml = $response.ContentType -like "text/html*" -and
                $body.Contains('<div id="root">') -and $body.Contains("/src/main.jsx")
        }
    }
    catch {
        return $null
    }
    finally {
        if ($null -ne $reader) {
            $reader.Dispose()
        }
        if ($null -ne $response) {
            $response.Dispose()
        }
    }
}

function Wait-ForHealth(
    [string]$Name,
    [string]$Url,
    [scriptblock]$IsHealthy,
    [System.Diagnostics.Process]$Process
) {
    for ($attempt = 0; $attempt -lt 180; $attempt++) {
        $health = Get-Health $Url
        if ($null -ne $health -and (& $IsHealthy $health)) {
            Write-Output "$Name is ready at $Url"
            return $health
        }
        if ($null -ne $Process -and $Process.HasExited) {
            break
        }
        Start-Sleep -Seconds 1
    }

    $details = ""
    $errorPath = Join-Path $logDirectory "$Name.stderr.log"
    if (Test-Path $errorPath) {
        $details = (Get-Content $errorPath -Tail 30) -join [Environment]::NewLine
    }
    throw "$Name did not become healthy at $Url. $details"
}

function Start-CheckedProcess(
    [string]$Name,
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [int]$Port,
    [string]$HealthUrl,
    [scriptblock]$IsHealthy
) {
    $existingHealth = Get-Health $HealthUrl
    if ($null -ne $existingHealth -and (& $IsHealthy $existingHealth)) {
        Write-Output "$Name already healthy at $HealthUrl"
        return $existingHealth
    }
    if (Test-LocalPort $Port) {
        throw "Port $Port is occupied by a service that failed the $Name health check. It was not stopped or replaced."
    }

    $stdoutPath = Join-Path $logDirectory "$Name.stdout.log"
    $stderrPath = Join-Path $logDirectory "$Name.stderr.log"
    $startArguments = @{
        FilePath = $FilePath
        WorkingDirectory = $WorkingDirectory
        RedirectStandardOutput = $stdoutPath
        RedirectStandardError = $stderrPath
        PassThru = $true
    }
    if ($Arguments.Count -gt 0) {
        $startArguments.ArgumentList = $Arguments
    }
    $process = Start-Process @startArguments
    return Wait-ForHealth $Name $HealthUrl $IsHealthy $process
}

$backendExe = Join-Path $runtimeDirectory "accident_backend.exe"
$backendSources = @(
    (Join-Path $backendDirectory "main.cpp"),
    (Join-Path $backendDirectory "database.cpp"),
    (Join-Path $backendDirectory "database.h"),
    (Join-Path $backendDirectory "circular_queue.h"),
    (Join-Path $backendDirectory "json_parser.h")
)
$needsBackendBuild = -not (Test-Path $backendExe)
if (-not $needsBackendBuild) {
    $backendTimestamp = (Get-Item $backendExe).LastWriteTimeUtc
    $needsBackendBuild = @($backendSources | Where-Object {
        (Get-Item $_).LastWriteTimeUtc -gt $backendTimestamp
    }).Count -gt 0
}
if ($needsBackendBuild) {
    $compiler = Get-Command g++ -ErrorAction Stop
    & $compiler.Source -std=c++17 -O2 `
        (Join-Path $backendDirectory "main.cpp") `
        (Join-Path $backendDirectory "database.cpp") `
        -lws2_32 -o $backendExe
    if ($LASTEXITCODE -ne 0) {
        throw "The C++ backend build failed with exit code $LASTEXITCODE."
    }
}

$env:SAD_PORT = "$backendPort"
Start-CheckedProcess `
    "backend" `
    $backendExe `
    @() `
    $backendDirectory `
    $backendPort `
    "http://127.0.0.1:$backendPort/api/health" `
    { param($health) $health.service -eq "cpp-backend" -and $health.status -eq "online" }

$uv = Get-Command uv -ErrorAction Stop
$pythonExe = Join-Path $aiDirectory ".venv\Scripts\python.exe"
if (-not (Test-Path $pythonExe)) {
    & $uv.Source venv --python 3.12 (Join-Path $aiDirectory ".venv")
    if ($LASTEXITCODE -ne 0) {
        throw "Could not create the Python 3.12 AI environment."
    }
}
if (-not (Test-Path (Join-Path $aiDirectory "models\yolo11n.pt")) -and
    -not (Test-Path (Join-Path $projectRoot "yolo11n.pt"))) {
    throw "The YOLO11n model is missing from AI\models and the repository root."
}
& $uv.Source pip install --python $pythonExe -r (Join-Path $aiDirectory "requirements.txt")
if ($LASTEXITCODE -ne 0) {
    throw "AI dependency installation failed."
}
$env:AI_BACKEND_URL = "http://127.0.0.1:$backendPort"
Start-CheckedProcess `
    "ai" `
    $pythonExe `
    @("-m", "uvicorn", "api:app", "--host", "127.0.0.1", "--port", "$aiPort") `
    $aiDirectory `
    $aiPort `
    "http://127.0.0.1:$aiPort/api/ai/status" `
    { param($health) $health.service -eq "Python AI" -and $health.status -ieq "online" -and $health.model -eq "YOLO11n" }

$node = Get-Command node -ErrorAction Stop
$npm = Get-Command npm -ErrorAction Stop
$notificationImports = "require('express'); require('cors'); require('twilio'); require('resend'); require('express-rate-limit'); require('dotenv')"
Push-Location $notificationDirectory
try {
    & $node.Source -e $notificationImports
    if ($LASTEXITCODE -ne 0) {
        & $npm.Source install
        if ($LASTEXITCODE -ne 0) {
            throw "Notification service dependency installation failed."
        }
        & $node.Source -e $notificationImports
        if ($LASTEXITCODE -ne 0) {
            throw "Notification dependencies are incomplete or corrupted after installation."
        }
    }
}
finally {
    Pop-Location
}
$env:NOTIFICATION_PORT = "$notificationPort"
Start-CheckedProcess `
    "notifications" `
    $node.Source `
    @("server.js") `
    $notificationDirectory `
    $notificationPort `
    "http://127.0.0.1:$notificationPort/api/health" `
    { param($health) $health.service -eq "notification-service" -and $health.status -eq "ok" }

if (-not (Test-Path (Join-Path $frontendDirectory "node_modules\vite"))) {
    $npm = Get-Command npm -ErrorAction Stop
    Push-Location $frontendDirectory
    try {
        & $npm.Source install
        if ($LASTEXITCODE -ne 0) {
            throw "Frontend dependency installation failed."
        }
    }
    finally {
        Pop-Location
    }
}
$env:VITE_BACKEND_API_URL = "http://127.0.0.1:$backendPort"
$env:VITE_AI_API_URL = "http://127.0.0.1:$aiPort"
$env:VITE_NOTIFICATION_API_URL = "http://127.0.0.1:$notificationPort"
$node = Get-Command node -ErrorAction Stop
$viteEntry = Join-Path $frontendDirectory "node_modules\vite\bin\vite.js"
Start-CheckedProcess `
    "frontend" `
    $node.Source `
    @($viteEntry, "--host", "127.0.0.1", "--port", "$frontendPort", "--strictPort") `
    $frontendDirectory `
    $frontendPort `
    "http://127.0.0.1:$frontendPort/" `
    { param($response) $response.reachable -eq $true -and $response.isFrontendHtml -eq $true }

$dashboardUrl = "http://127.0.0.1:$frontendPort/"
Write-Output "Demo dashboard: $dashboardUrl"
Write-Output "Backend health: http://127.0.0.1:$backendPort/api/health"
Write-Output "AI health: http://127.0.0.1:$aiPort/api/ai/status"
Write-Output "Notification health: http://127.0.0.1:$notificationPort/api/health"
Write-Output "Service logs: $logDirectory"
if (-not $NoBrowser) {
    Start-Process $dashboardUrl
}
