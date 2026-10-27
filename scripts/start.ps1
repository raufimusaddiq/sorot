<#
.SYNOPSIS
    Start Sorot (one command)
.DESCRIPTION
    Docker install (default): pulls the ready-made image from
    ghcr.io/raufimusaddiq/sorot the first time (or builds it with -Build),
    then starts it. The image serves the static UI and the API together on
    http://localhost:8080.
    Native install (scripts\install.ps1 -Mode native wrote .env.native): starts
    the app in the background with Bun; logs go to data\logs\sorot.log.
.PARAMETER Build
    Docker: build the image from source instead of pulling it (~10 min).
.PARAMETER Update
    Docker: pull the newest image before starting.
.PARAMETER Dev
    Docker: also start the hot-reload Next.js dev UI on http://localhost:3000.
.PARAMETER Open
    Open the studio in the browser once the app is up.
#>

param(
    [switch]$Build,
    [switch]$Update,
    [switch]$Dev,
    [switch]$Open
)

$ErrorActionPreference = "Continue"
$ProjectRoot = $PSScriptRoot | Split-Path

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Set-Location $ProjectRoot

if (-not (Test-Path "data")) { New-Item -ItemType Directory -Path "data" -Force | Out-Null }
foreach ($sub in @("raw","audio","transcripts","segments","renders","exports","variations","analytics","logs","input","music")) {
    $dir = Join-Path "data" $sub
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

$Native = Test-Path ".env.native"
$Port = 8080

function Wait-Url {
    param([string]$Url, [string]$Label, [int]$Tries)
    Write-Host "       ${Label}: waiting for it to answer..." -NoNewline
    while ($Tries -gt 0) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
            if ($r.StatusCode -eq 200) { Write-Host " OK" -ForegroundColor Green; return $true }
        } catch {}
        Start-Sleep -Seconds 2
        Write-Host "." -NoNewline
        $Tries--
    }
    Write-Host " TIMEOUT" -ForegroundColor Red
    return $false
}

# --- native ---------------------------------------------------------------------

function Start-Native {
    # Same KEY=VALUE format as .env.docker; PATH_PREPEND goes in front of PATH.
    foreach ($line in Get-Content ".env.native") {
        if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') {
            $key = $Matches[1]; $value = $Matches[2]
            if ($key -eq "PATH_PREPEND") { if ($value) { $env:Path = "$value;$env:Path" } }
            else { Set-Item -Path "Env:$key" -Value $value }
        }
    }
    if ($env:SERVER_PORT) { $script:Port = [int]$env:SERVER_PORT }

    $bun = Join-Path $ProjectRoot ".tools\bun\bun.exe"
    if (-not (Test-Path $bun)) { $bun = (Get-Command bun -ErrorAction SilentlyContinue).Source }
    if (-not $bun) {
        Write-Host "Bun not found. Re-run: scripts\install.ps1 -Mode native" -ForegroundColor Red
        exit 1
    }
    $running = Get-Process bun -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $bun }
    if ($running) {
        Write-Host "[1/1] Sorot is already running (native)." -ForegroundColor Green
        return
    }
    Write-Host "[1/1] Starting Sorot (native)..." -ForegroundColor Yellow
    $log = Join-Path $ProjectRoot "data\logs\sorot.log"
    # cmd.exe for the redirect: one plain-text log, no PowerShell error records.
    $cmdLine = "/c `"`"$bun`" run src/index.ts >> `"$log`" 2>&1`""
    Start-Process -FilePath "cmd.exe" -ArgumentList $cmdLine -WorkingDirectory (Join-Path $ProjectRoot "backend") -WindowStyle Hidden | Out-Null
}

# --- docker ---------------------------------------------------------------------

function Invoke-Compose {
    $out = docker compose --env-file .env.docker @args 2>&1
    $script:ComposeOut = $out
    return $LASTEXITCODE
}

function Ensure-DockerRunning {
    $null = docker info 2>&1
    if ($LASTEXITCODE -eq 0) { return }
    $exe = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path $exe) {
        Write-Host "       Starting Docker Desktop..." -ForegroundColor Yellow
        Start-Process $exe
        $deadline = (Get-Date).AddSeconds(180)
        do {
            Start-Sleep -Seconds 3
            $null = docker info 2>&1
        } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "       Docker isn't running. Start Docker Desktop and try again." -ForegroundColor Red
        exit 1
    }
}

function Start-Docker {
    Ensure-DockerRunning
    $image = (docker compose --env-file .env.docker config --images 2>$null | Where-Object { $_ -match "sorot:" } | Select-Object -First 1)
    $null = docker image inspect $image 2>&1
    $haveImage = $LASTEXITCODE -eq 0

    Write-Host "[1/3] App image ($image)..." -ForegroundColor Yellow
    if ($Build) {
        Write-Host "       Building from source (first time ~10 min)..." -ForegroundColor Yellow
        if ((Invoke-Compose build backend) -ne 0) {
            $script:ComposeOut | Select-Object -Last 15 | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
            Write-Host "       Build FAILED" -ForegroundColor Red
            exit 1
        }
        Write-Host "       Built." -ForegroundColor Green
    } elseif ($Update -or -not $haveImage) {
        Write-Host "       Pulling (several GB the first time; updates download only what changed)..." -ForegroundColor Yellow
        docker compose --env-file .env.docker pull backend
        if ($LASTEXITCODE -ne 0) {
            if ($haveImage) {
                Write-Host "       Pull failed; starting the image you already have." -ForegroundColor DarkYellow
            } else {
                Write-Host "       Pull FAILED. Check your connection, or build it yourself: scripts\start.ps1 -Build" -ForegroundColor Red
                exit 1
            }
        } else {
            Write-Host "       Up to date." -ForegroundColor Green
        }
    } else {
        Write-Host "       Using the local image. -Update pulls the newest, -Build builds from source." -ForegroundColor Green
    }

    if ($Dev) {
        Write-Host "       Building the dev UI image..." -ForegroundColor Yellow
        $null = docker image inspect sorot-frontend:latest 2>&1
        if ($Build -or $LASTEXITCODE -ne 0) {
            if ((Invoke-Compose --profile dev build frontend) -ne 0) {
                $script:ComposeOut | Select-Object -Last 15 | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
                exit 1
            }
        }
    }

    Write-Host "[2/3] Removing replaced images..." -ForegroundColor Yellow
    docker image prune -f 2>$null | Out-Null
    if ($Build) { docker builder prune -f 2>$null | Out-Null }

    Write-Host "[3/3] Starting services..." -ForegroundColor Yellow
    $services = @("backend")
    $profileArgs = @()
    if ($Dev) { $services += "frontend"; $profileArgs = @("--profile", "dev") }
    if ((Invoke-Compose @profileArgs up -d @services) -ne 0) {
        Write-Host "       Docker compose up FAILED:" -ForegroundColor Red
        $script:ComposeOut | ForEach-Object { Write-Host "       $_" -ForegroundColor DarkGray }
        exit 1
    }
    $published = (docker compose --env-file .env.docker port backend 8080 2>$null | Select-Object -First 1)
    if ($published -match ":(\d+)$") { $script:Port = [int]$Matches[1] }
}

# --- main -----------------------------------------------------------------------

Write-Host ""
Write-Host "=== Sorot Startup ($(if ($Native) { 'native' } else { 'docker' })) ===" -ForegroundColor Cyan
Write-Host ""

if ($Native) { Start-Native } else { Start-Docker }

Write-Host ""
$healthy = Wait-Url -Url "http://localhost:$Port/api/health" -Label "App" -Tries 60
if (-not $healthy) {
    if ($Native) { Write-Host "       Check: data\logs\sorot.log" -ForegroundColor Yellow }
    else { Write-Host "       Check: docker compose --env-file .env.docker logs backend" -ForegroundColor Yellow }
}
if ($Dev -and -not $Native) {
    if (-not (Wait-Url -Url "http://localhost:3000" -Label "Dev UI" -Tries 20)) {
        Write-Host "       Check: docker compose --env-file .env.docker logs frontend" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=== Services Running ===" -ForegroundColor Green
Write-Host "  App:      http://localhost:$Port  (studio: /studio)" -ForegroundColor Cyan
if ($Dev -and -not $Native) { Write-Host "  Dev UI:   http://localhost:3000 (hot reload)" -ForegroundColor Cyan }
Write-Host "  Health:   http://localhost:$Port/api/health" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Stop:     scripts\stop.ps1" -ForegroundColor DarkGray
if ($Native) { Write-Host "  Logs:     data\logs\sorot.log" -ForegroundColor DarkGray }
else { Write-Host "  Logs:     docker compose --env-file .env.docker logs -f backend" -ForegroundColor DarkGray }
Write-Host ""

if ($Open -and $healthy) { Start-Process "http://localhost:$Port/studio" }
