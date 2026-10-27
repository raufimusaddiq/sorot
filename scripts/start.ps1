<#
.SYNOPSIS
    Start Sorot full stack (one command)
.DESCRIPTION
    Builds Docker images with version tags, keeps last N versions,
    cleans old images + build cache, then starts the app. The backend image
    serves the static UI and the API together on http://localhost:8080.
.PARAMETER Dev
    Also start the hot-reload Next.js dev UI on http://localhost:3000.
#>

param(
    [switch]$Build,
    [switch]$Dev,
    [int]$KeepN = 3
)

$ErrorActionPreference = "Continue"
$ProjectRoot = $PSScriptRoot | Split-Path

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Set-Location $ProjectRoot

if (-not (Test-Path "data")) { New-Item -ItemType Directory -Path "data" -Force | Out-Null }
foreach ($sub in @("raw","audio","transcripts","segments","renders","exports","variations","analytics","logs")) {
    $dir = Join-Path "data" $sub
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

$VERSION = Get-Date -Format "yyyyMMddHHmmss"

function Build-ServiceImage {
    param(
        [string]$ImageName,
        [string]$Dockerfile,
        [string]$Target
    )

    Write-Host "       Building ${ImageName}:$VERSION ..." -ForegroundColor Yellow

    $buildArgs = @("build", "-t", "${ImageName}:$VERSION", "-t", "${ImageName}:latest", "-f", $Dockerfile, ".")
    if ($Target) {
        $buildArgs += "--target"
        $buildArgs += $Target
    }

    $buildResult = docker @buildArgs 2>&1
    $buildExit = $LASTEXITCODE
    $errors = $buildResult | Where-Object { $_ -match "ERROR|FAILED" -and $_ -notmatch "WARN" }
    if ($errors) {
        $errors | ForEach-Object { Write-Host "       $_" -ForegroundColor Red }
    }
    if ($buildExit -ne 0) {
        Write-Host "       Build FAILED for $ImageName (exit code $buildExit)" -ForegroundColor Red
        exit 1
    }
    Write-Host "       ${ImageName}:$VERSION built." -ForegroundColor Green
}

function Remove-OldImages {
    param(
        [string]$ImageName,
        [int]$Keep
    )

    # `docker images` already returns images newest-first, so we don't need
    # to parse the locale-dependent CreatedAt column — just slice off the
    # top `Keep` entries and drop the rest. Version tags are timestamp-
    # prefixed (yyyyMMddHHmmss) so they sort identically whether we sort by
    # name or by creation date.
    $names = docker images $ImageName --format "{{.Repository}}:{{.Tag}}" 2>$null |
             Where-Object { $_ -and $_ -notmatch "<none>" -and $_ -ne "${ImageName}:latest" } |
             Sort-Object -Descending -Unique

    if (-not $names) { return }

    $toDelete = $names | Select-Object -Skip $Keep
    foreach ($name in $toDelete) {
        Write-Host "       Removing old image: $name" -ForegroundColor DarkGray
        docker rmi $name 2>$null | Out-Null
    }
}

Write-Host ""
Write-Host "=== Sorot Startup ===" -ForegroundColor Cyan
Write-Host "       Version: $VERSION | Keep last: $KeepN builds" -ForegroundColor DarkGray
Write-Host ""

if ($true) {
    Write-Host "[1/5] Building app image (API + UI + pipeline)..." -ForegroundColor Yellow
    $backendImage = docker images --format "{{.Repository}}:{{.Tag}}" 2>$null | Select-String "sorot-backend"

    if ($Build -or -not $backendImage) {
        Build-ServiceImage -ImageName "sorot-backend" -Dockerfile "backend/Dockerfile"
    } else {
        Write-Host "       Backend image exists. Use -Build to rebuild." -ForegroundColor Green
    }
}

if ($Dev) {
    Write-Host "[2/5] Building frontend dev image..." -ForegroundColor Yellow
    $frontendImage = docker images --format "{{.Repository}}:{{.Tag}}" 2>$null | Select-String "sorot-frontend"

    if ($Build -or -not $frontendImage) {
        Build-ServiceImage -ImageName "sorot-frontend" -Dockerfile "frontend/Dockerfile" -Target "dev"
    } else {
        Write-Host "       Frontend image exists. Use -Build to rebuild." -ForegroundColor Green
    }
}

Write-Host "[3/5] Cleaning old images (keeping last $KeepN)..." -ForegroundColor Yellow
Remove-OldImages -ImageName "sorot-backend" -Keep $KeepN
Remove-OldImages -ImageName "sorot-frontend" -Keep $KeepN
Write-Host "       Old images cleaned." -ForegroundColor Green

Write-Host "[4/5] Pruning dangling images + build cache..." -ForegroundColor Yellow
docker image prune -f 2>$null | Out-Null
docker builder prune -f 2>$null | Out-Null
Write-Host "       Cache pruned." -ForegroundColor Green

Write-Host "[5/5] Starting services..." -ForegroundColor Yellow
$services = @("backend")
$profileArgs = @()
if ($Dev) { $services += "frontend"; $profileArgs = @("--profile", "dev") }

$upResult = docker compose --env-file .env.docker @profileArgs up -d @services 2>&1
$upExit = $LASTEXITCODE
if ($upExit -ne 0) {
    Write-Host "       Docker compose up FAILED (exit code $upExit):" -ForegroundColor Red
    Write-Host "       $upResult" -ForegroundColor DarkGray
    exit 1
}

Write-Host ""
Write-Host "=== Waiting for services ===" -ForegroundColor Yellow

if ($true) {
    Write-Host "       App: waiting for health check..." -NoNewline
    $retries = 30
    $healthy = $false
    while ($retries -gt 0) {
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:8080/api/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
            if ($r.StatusCode -eq 200) { $healthy = $true; break }
        } catch {}
        Start-Sleep -Seconds 2
        Write-Host "." -NoNewline
        $retries--
    }
    if ($healthy) {
        Write-Host " OK" -ForegroundColor Green
    } else {
        Write-Host " TIMEOUT" -ForegroundColor Red
        Write-Host "       Check: docker compose --env-file .env.docker logs backend" -ForegroundColor Yellow
    }
}

if ($Dev) {
    Write-Host "       Dev UI: waiting for response..." -NoNewline
    $retries = 20
    $ready = $false
    while ($retries -gt 0) {
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 2
        Write-Host "." -NoNewline
        $retries--
    }
    if ($ready) {
        Write-Host " OK" -ForegroundColor Green
    } else {
        Write-Host " TIMEOUT" -ForegroundColor Red
        Write-Host "       Check: docker compose --env-file .env.docker logs frontend" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=== Services Running ===" -ForegroundColor Green
Write-Host "  App:      http://localhost:8080  (studio: /studio)" -ForegroundColor Cyan
if ($Dev) { Write-Host "  Dev UI:   http://localhost:3000 (hot reload)" -ForegroundColor Cyan }
Write-Host "  Health:   http://localhost:8080/api/health" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Stop:     scripts\stop.ps1" -ForegroundColor DarkGray
Write-Host "  Logs:     docker compose --env-file .env.docker logs -f" -ForegroundColor DarkGray
Write-Host "  E2E Test: scripts\e2e-test.ps1" -ForegroundColor DarkGray
Write-Host ""
