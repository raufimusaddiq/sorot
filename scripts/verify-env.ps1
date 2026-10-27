<#
.SYNOPSIS
    Verify all dependencies for Viral Clipper
.DESCRIPTION
    Checks Docker, GPU passthrough, Node.js, Bun, Python venv, ffmpeg, and the
    AI-pipeline Python packages. Returns exit code 0 if required checks pass,
    1 if required items missing. Optional deps (yt-dlp on host, lightgbm for
    scorer retraining) print a warning but don't fail the check.
#>

$ErrorActionPreference = "Continue"
Set-Location ($PSScriptRoot | Split-Path)

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

$VENV_PY = "ai-pipeline\.venv\Scripts\python.exe"

function Check-Required($name, $cmd) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        Write-Host "  [OK] $name" -ForegroundColor Green
        return $true
    } else {
        Write-Host "  [MISSING] $name ($cmd not found)" -ForegroundColor Red
        return $false
    }
}

function Check-Optional($name, $cmd, $hint) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        Write-Host "  [OK] $name" -ForegroundColor Green
    } else {
        Write-Host "  [OPTIONAL] $name not on host ($hint)" -ForegroundColor DarkYellow
    }
}

function Check-VenvImport($module, $required, $hint) {
    $out = & $VENV_PY -c "import $module; print('ok')" 2>&1
    if ($out -match "ok") {
        Write-Host "  [OK] venv: $module" -ForegroundColor Green
        return $true
    }
    if ($required) {
        Write-Host "  [MISSING] venv: $module" -ForegroundColor Red
        return $false
    }
    Write-Host "  [OPTIONAL] venv: $module not installed ($hint)" -ForegroundColor DarkYellow
    return $true
}

function Check-DockerGPU {
    Write-Host "  Checking Docker GPU passthrough..." -NoNewline
    $null = docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host " OK" -ForegroundColor Green
        return $true
    }
    Write-Host " FAILED" -ForegroundColor Red
    Write-Host "    GPU not available in Docker. Install NVIDIA Container Toolkit." -ForegroundColor Yellow
    return $false
}

Write-Host "`n=== Viral Clipper Environment Check ===" -ForegroundColor Cyan
Write-Host ""

$allOk = $true

Write-Host "--- Core Dependencies ---" -ForegroundColor Yellow
$allOk = $allOk -and (Check-Required "Docker" "docker")
$allOk = $allOk -and (Check-Required "Node.js" "node")
$allOk = $allOk -and (Check-Required "Bun" "bun")
$allOk = $allOk -and (Check-Required "Python" "python")
$allOk = $allOk -and (Check-Required "ffmpeg" "ffmpeg")
# yt-dlp is bundled inside the Docker image via requirements.txt (P4 change);
# only needed on host for local testing outside Docker.
Check-Optional "yt-dlp on host" "yt-dlp" "bundled inside Docker; install on host only for native dev"

Write-Host ""
Write-Host "--- Python AI Pipeline ---" -ForegroundColor Yellow
if (Test-Path $VENV_PY) {
    Write-Host "  [OK] Python venv" -ForegroundColor Green
    $allOk = $allOk -and (Check-VenvImport "faster_whisper" $true "")
    $allOk = $allOk -and (Check-VenvImport "cv2" $true "")
    $allOk = $allOk -and (Check-VenvImport "numpy" $true "")
    # Supervised-scorer deps — only used by train_scorer.py.
    Check-VenvImport "lightgbm" $false "needed only for train_scorer.py (P3.5-C)" | Out-Null
    Check-VenvImport "sklearn" $false "needed only for train_scorer.py (P3.5-C)" | Out-Null
} else {
    Write-Host "  [MISSING] Python venv at $VENV_PY" -ForegroundColor Red
    Write-Host "            Run: python -m venv ai-pipeline\.venv" -ForegroundColor DarkGray
    Write-Host "                 .\ai-pipeline\.venv\Scripts\pip install -r ai-pipeline\requirements.txt" -ForegroundColor DarkGray
    $allOk = $false
}

Write-Host ""
Write-Host "--- Docker GPU ---" -ForegroundColor Yellow
$allOk = $allOk -and (Check-DockerGPU)

Write-Host ""
Write-Host "--- Project Files ---" -ForegroundColor Yellow
$files = @(
    @("docker-compose.yml", "Docker Compose config"),
    @(".env.docker", "Docker env vars"),
    @("backend\Dockerfile", "Backend Dockerfile"),
    @("frontend\Dockerfile", "Frontend Dockerfile"),
    @("backend\src\db.ts", "Database schema"),
    @("bun.lock", "Bun workspace lockfile"),
    @("ai-pipeline\transcribe.py", "Transcribe script"),
    @("ai-pipeline\segment.py", "Segment script"),
    @("ai-pipeline\score.py", "Score script"),
    @("ai-pipeline\features\__init__.py", "features/ package (P3.5-A)"),
    @("ai-pipeline\train_scorer.py", "Supervised trainer (P3.5-C)"),
    @("ai-pipeline\weights.json", "Scoring weights (v3)")
)
foreach ($f in $files) {
    if (Test-Path $f[0]) {
        Write-Host "  [OK] $($f[1])" -ForegroundColor Green
    } else {
        Write-Host "  [MISSING] $($f[1]) ($($f[0]))" -ForegroundColor Red
        $allOk = $false
    }
}

Write-Host ""
Write-Host "--- Unit Tests ---" -ForegroundColor Yellow
if (Test-Path $VENV_PY) {
    $pytestResult = & $VENV_PY -m pytest ai-pipeline/tests/ -q --tb=no 2>&1
    if ($LASTEXITCODE -eq 0) {
        $line = ($pytestResult | Select-String "passed").Line
        Write-Host "  [OK] Python tests: $line" -ForegroundColor Green
    } else {
        Write-Host "  [FAIL] Python tests failing" -ForegroundColor Red
        $allOk = $false
    }
} else {
    Write-Host "  [SKIP] venv missing, can't run pytest" -ForegroundColor DarkYellow
}

Write-Host ""
if ($allOk) {
    Write-Host "=== ALL CHECKS PASSED ===" -ForegroundColor Green
    Write-Host "Run: scripts\start.ps1" -ForegroundColor Cyan
    exit 0
} else {
    Write-Host "=== SOME CHECKS FAILED ===" -ForegroundColor Red
    Write-Host "Fix the missing items above, then re-run this script." -ForegroundColor Yellow
    exit 1
}
