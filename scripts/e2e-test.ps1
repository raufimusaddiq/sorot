<#
.SYNOPSIS
    Run full E2E test suite (pipeline + browser + unit)
.DESCRIPTION
    Phase 1: Python pipeline E2E (no backend needed)
    Phase 2: Playwright browser E2E (needs stack — run scripts\start.ps1 first)
    Phase 3: Python unit tests (ai-pipeline/tests)

    ErrorActionPreference="Continue" per project convention — docker /
    playwright write progress to stderr; "Stop" would crash on the first line.
#>

param(
    [switch]$PipelineOnly,
    [switch]$BrowserOnly,
    [switch]$UnitOnly
)

$ErrorActionPreference = "Continue"
Set-Location ($PSScriptRoot | Split-Path)

$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

$VENV_PY = "ai-pipeline\.venv\Scripts\python.exe"
if (-not (Test-Path $VENV_PY)) {
    $VENV_PY = "python"
}

$exitCode = 0

# ──────────────────────────────────────────────
# Phase 1: Python Pipeline E2E
# ──────────────────────────────────────────────
if (-not $BrowserOnly -and -not $UnitOnly) {
    Write-Host "`n=== Phase 1: Pipeline E2E Tests ===" -ForegroundColor Cyan
    Write-Host "Testing: deps -> transcribe -> segment -> score -> render -> subtitle -> supervised guard" -ForegroundColor DarkGray
    Write-Host ""

    & $VENV_PY scripts\e2e_pipeline_test.py -v
    if ($LASTEXITCODE -ne 0) {
        Write-Host "`n  [FAIL] Pipeline E2E tests failed" -ForegroundColor Red
        $exitCode = 1
    } else {
        Write-Host "`n  [PASS] Pipeline E2E tests passed" -ForegroundColor Green
    }
}

# ──────────────────────────────────────────────
# Phase 2: Playwright Browser E2E
# ──────────────────────────────────────────────
if (-not $PipelineOnly -and -not $UnitOnly) {
    Write-Host "`n=== Phase 2: Browser E2E Tests ===" -ForegroundColor Cyan
    Write-Host "Testing: frontend UI -> backend API -> full user flow" -ForegroundColor DarkGray
    Write-Host ""

    $backendUp = $false
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:8080/api/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($r.StatusCode -eq 200) { $backendUp = $true }
    } catch {}

    # The static UI is served by the backend on the same port.
    $frontendUp = $false
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:8080/" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
        if ($r.StatusCode -eq 200) { $frontendUp = $true }
    } catch {}

    if (-not $backendUp -or -not $frontendUp) {
        Write-Host "  [SKIP] Stack not running." -ForegroundColor Yellow
        if (-not $backendUp)  { Write-Host "         Backend not reachable at :8080" -ForegroundColor Yellow }
        if (-not $frontendUp) { Write-Host "         UI not served at :8080 (static export missing?)" -ForegroundColor Yellow }
        Write-Host "         Run scripts\start.ps1 first, then re-run E2E." -ForegroundColor Yellow
    } else {
        # Push/Pop keeps CWD sane even if playwright bombs.
        Push-Location frontend
        try {
            bunx playwright test --reporter=list
            if ($LASTEXITCODE -ne 0) {
                Write-Host "`n  [FAIL] Browser E2E tests failed" -ForegroundColor Red
                Write-Host "         Report: frontend\playwright-report\index.html" -ForegroundColor DarkGray
                $exitCode = 1
            } else {
                Write-Host "`n  [PASS] Browser E2E tests passed" -ForegroundColor Green
            }
        } finally {
            Pop-Location
        }
    }
}

# ──────────────────────────────────────────────
# Phase 3: Python Unit Tests
# ──────────────────────────────────────────────
if (-not $BrowserOnly -and -not $PipelineOnly) {
    Write-Host "`n=== Phase 3: Unit Tests ===" -ForegroundColor Cyan

    & $VENV_PY -m pytest ai-pipeline/tests/ -q --tb=no
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [FAIL] Unit tests failed" -ForegroundColor Red
        $exitCode = 1
    } else {
        Write-Host "  [PASS] Unit tests passed" -ForegroundColor Green
    }
}

# ──────────────────────────────────────────────
Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "=== ALL E2E TESTS PASSED ===" -ForegroundColor Green
} else {
    Write-Host "=== SOME E2E TESTS FAILED ===" -ForegroundColor Red
}
Write-Host ""
exit $exitCode
