<#
.SYNOPSIS
    Stop all Viral Clipper services
.PARAMETER Compact
    Also compact WSL2 disk after shutdown
#>

param(
    [switch]$Compact
)

$ErrorActionPreference = "Continue"
Set-Location ($PSScriptRoot | Split-Path)

Write-Host "Stopping Viral Clipper..." -ForegroundColor Yellow
docker compose --env-file .env.docker --profile dev down 2>&1 | Out-Null
Write-Host "All services stopped." -ForegroundColor Green

if ($Compact) {
    Write-Host ""
    Write-Host "=== WSL2 Disk Compaction ===" -ForegroundColor Yellow

    $vhdxPath = Join-Path $env:LOCALAPPDATA "Docker\wsl\data\ext4.vhdx"
    if (-not (Test-Path $vhdxPath)) {
        Write-Host "       Docker WSL2 disk not found at: $vhdxPath" -ForegroundColor Red
        Write-Host "       Skipping compaction." -ForegroundColor DarkGray
        return
    }

    $before = (Get-Item $vhdxPath).Length / 1GB
    Write-Host "       Current size: $([math]::Round($before, 2)) GB" -ForegroundColor DarkGray

    Write-Host "       Shutting down WSL..." -ForegroundColor Yellow
    wsl --shutdown 2>$null

    Write-Host "       Compacting disk (this may take a while)..." -ForegroundColor Yellow
    try {
        Optimize-VHD -Path $vhdxPath -Mode Full -ErrorAction Stop
        $after = (Get-Item $vhdxPath).Length / 1GB
        $saved = [math]::Round($before - $after, 2)
        Write-Host "       New size: $([math]::Round($after, 2)) GB (saved $saved GB)" -ForegroundColor Green
    } catch {
        Write-Host "       Compaction requires Administrator privileges." -ForegroundColor Red
        Write-Host "       Run PowerShell as Admin, then:" -ForegroundColor Yellow
        Write-Host "       scripts\stop.ps1 -Compact" -ForegroundColor Cyan
    }
}
