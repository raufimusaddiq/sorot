<#
.SYNOPSIS
    Install Sorot on Windows: Docker Desktop (pulls the ready-made image) or native.
.DESCRIPTION
    From a checkout:   .\scripts\install.ps1 [-Mode docker|native] [options]
    Without git:       irm https://raw.githubusercontent.com/raufimusaddiq/sorot/master/scripts/install.ps1 | iex
                       (options: & ([scriptblock]::Create((irm <same url>))) -Mode native)

    Docker mode pulls ghcr.io/raufimusaddiq/sorot and runs it with Docker
    Desktop (GPU when an NVIDIA driver is present, else CPU).
    Native mode needs no Docker: Bun, a Python venv and ffmpeg (winget) run the
    app straight on Windows, started at logon from the Startup folder.

    Both modes add "Sorot" and "Stop Sorot" to the Start menu. Re-run to update;
    -Uninstall [-Purge] to remove.
.PARAMETER Mode
    docker (default) or native.
.PARAMETER Dir
    Where to put the app when the script isn't run from a checkout
    (default %LOCALAPPDATA%\Sorot).
.PARAMETER Build
    Docker: build the image from source instead of pulling it (~10 min).
.PARAMETER Cpu
    Don't use the NVIDIA GPU even if one is present.
.PARAMETER SkipModel
    Native: don't pre-download the Whisper model (downloads on first use).
.PARAMETER NoStart
    Install, don't start.
.PARAMETER Uninstall
    Stop the app and remove shortcuts and machine settings; keeps data\.
.PARAMETER Purge
    With -Uninstall: also delete data\ (videos, clips, database), the venv,
    the downloaded tools and the Docker image.
#>

param(
    [ValidateSet("docker", "native")]
    [string]$Mode = "docker",
    [int]$Port = 8080,
    [string]$Dir = "",
    [switch]$Build,
    [switch]$Cpu,
    [switch]$SkipModel,
    [switch]$NoStart,
    [switch]$Uninstall,
    [switch]$Purge
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar
# This process only: lets it run scripts\start.ps1 / stop.ps1 under the default "Restricted" policy.
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "raufimusaddiq/sorot"
$BunVersion = "1.3.12"          # same as backend/Dockerfile and scripts/install.sh
$ComposeMin = [version]"2.24"   # docker-compose.override.yml uses !override / !reset

# No `exit` below: under `irm | iex` it would close the user's PowerShell window.
function Fail($msg) { throw $msg }
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host " OK $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host " !  $msg" -ForegroundColor Yellow }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Refresh-Path {
    # winget installs land in the registry PATH, not this session's.
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

function Winget-Install($id, $what) {
    if (-not (Have winget)) { Fail "$what is missing and winget isn't available. Install $what yourself, then re-run." }
    Step "Installing $what (winget $id)"
    $out = winget install -e --id $id --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1
    if ($LASTEXITCODE -ne 0 -and -not ($out | Select-String -Quiet "already installed|No newer package|No available upgrade")) {
        $out | Select-Object -Last 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Fail "winget couldn't install $what (exit $LASTEXITCODE)"
    }
    Refresh-Path
}

function Gpu-Present {
    if ($Cpu -or -not (Have nvidia-smi)) { return $false }
    $null = nvidia-smi -L 2>&1
    return $LASTEXITCODE -eq 0
}

function Wait-Healthy($seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($r.StatusCode -eq 200) { return $true }
        } catch {}
        Start-Sleep -Seconds 2
    }
    return $false
}

# --- app files ---------------------------------------------------------------------

function Resolve-AppDir {
    if ($PSScriptRoot) {
        $root = Split-Path $PSScriptRoot
        if (Test-Path (Join-Path $root "docker-compose.yml")) { return $root }
    }
    if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA "Sorot" }
    return $Dir
}

# Not a checkout (run via irm | iex): fetch master's source. Your data\,
# settings, venv and tools are left alone on updates.
function Download-Source($dest) {
    Step "Downloading Sorot ($Repo, master)"
    $tmp = Join-Path $env:TEMP ("sorot-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    $zip = Join-Path $tmp "src.zip"
    try {
        Invoke-WebRequest -Uri "https://github.com/$Repo/archive/refs/heads/master.zip" -OutFile $zip -UseBasicParsing -ErrorAction Stop
    } catch { Fail "Download failed: $($_.Exception.Message)" }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    $null = robocopy $src.FullName $dest /E /NFL /NDL /NJH /NJS /NP `
        /XD data .venv node_modules .tools out .next `
        /XF .env.native .env.llm docker-compose.override.yml
    if ($LASTEXITCODE -ge 8) { Fail "Copying the source to $dest failed (robocopy $LASTEXITCODE)" }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem (Join-Path $dest "scripts") -Filter *.ps1 | Unblock-File
    Ok "Source in $dest"
}

function Ensure-DataDirs($app) {
    foreach ($sub in @("input", "music", "logs")) {
        New-Item -ItemType Directory -Path (Join-Path $app "data\$sub") -Force | Out-Null
    }
}

# Start menu: "Sorot" starts the app and opens the studio; "Stop Sorot" stops it.
function Shortcut($path, $script, $arguments, [switch]$Hidden) {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($path)
    $lnk.TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $style = if ($Hidden) { "-WindowStyle Hidden " } else { "" }
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass $style-File `"$script`" $arguments"
    $lnk.WorkingDirectory = Split-Path (Split-Path $script)
    $lnk.Save()
}

$StartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$StartupLnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\Sorot.lnk"

function Write-Shortcuts($app, $native) {
    $scripts = Join-Path $app "scripts"
    Shortcut (Join-Path $StartMenu "Sorot.lnk") (Join-Path $scripts "start.ps1") "-Open"
    Shortcut (Join-Path $StartMenu "Stop Sorot.lnk") (Join-Path $scripts "stop.ps1") ""
    if ($native) {
        # Docker mode comes back on its own (restart: unless-stopped) once Docker Desktop starts.
        Shortcut $StartupLnk (Join-Path $scripts "start.ps1") "" -Hidden
    } else {
        Remove-Item $StartupLnk -Force -ErrorAction SilentlyContinue   # left over from a native install
    }
    Ok "Start menu: Sorot, Stop Sorot$(if ($native) { '; starts at logon' })"
}

# --- docker mode --------------------------------------------------------------------

function Ensure-Docker {
    if (-not (Have docker)) {
        Winget-Install "Docker.DockerDesktop" "Docker Desktop"
        Fail "Docker Desktop is installed. Start it once (and reboot if it asks to enable WSL2), then re-run this installer."
    }
    $null = docker info 2>&1
    if ($LASTEXITCODE -ne 0) {
        $exe = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
        if (Test-Path $exe) {
            Step "Starting Docker Desktop"
            Start-Process $exe
            $deadline = (Get-Date).AddSeconds(180)
            do {
                Start-Sleep -Seconds 3
                $null = docker info 2>&1
            } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $deadline)
        }
        if ($LASTEXITCODE -ne 0) { Fail "Docker isn't running. Start Docker Desktop, then re-run." }
    }
    $v = (docker compose version --short 2>$null | Out-String).Trim().TrimStart("v")
    $parsed = $null
    if (-not [version]::TryParse(($v -replace "[^0-9.].*$", ""), [ref]$parsed) -or $parsed -lt $ComposeMin) {
        Fail "Docker Compose $ComposeMin+ is needed (found '$v'). Update Docker Desktop, then re-run."
    }
    Ok "Docker with compose $v"
}

function Write-Override($app, $gpu) {
    . (Join-Path $app "scripts\compose-override.ps1")
    Write-SorotOverride -Root $app -Port $Port -Gpu $gpu -Writer "scripts/install.ps1"
    Ok "Compose settings: docker-compose.override.yml (port $Port, $(if ($gpu) { 'GPU, -cuda image' } else { 'CPU image' }))"
}

function Compose {
    $out = docker compose --env-file .env.docker @args 2>&1
    $script:ComposeOut = $out
    return $LASTEXITCODE
}

function Install-Docker($app) {
    Ensure-Docker
    # Docker Desktop passes the GPU through itself on WSL2: only the Windows NVIDIA driver is needed.
    $gpu = Gpu-Present
    if (-not $gpu) { Warn "No NVIDIA GPU in use: transcription and encoding run on the CPU (roughly 1 h per hour of video on 12 cores)" }
    Write-Override $app $gpu
    Ensure-DataDirs $app
    Push-Location $app
    try {
        if ($Build) {
            Step "Building the image from source (first time ~10 min)"
            if ((Compose build backend) -ne 0) { $script:ComposeOut | Select-Object -Last 15 | Write-Host; Fail "Image build failed" }
        } else {
            Step "Pulling the $(if ($gpu) { 'CUDA' } else { 'CPU' }) image from ghcr.io/$Repo (GB-sized the first time; updates download only what changed)"
            docker compose --env-file .env.docker pull backend
            if ($LASTEXITCODE -ne 0) { Fail "Pull failed. Check your connection, or build it yourself: -Build" }
        }
        Ok "Image ready"
        if (-not $NoStart) {
            Step "Starting"
            if ((Compose up -d backend) -ne 0) {
                if ($gpu) {
                    # Driver present but Docker can't hand out the GPU (old driver, no WSL2 backend...).
                    Warn "Docker couldn't use the GPU; falling back to the CPU"
                    Write-Override $app $false
                    if ((Compose up -d backend) -ne 0) { $script:ComposeOut | Write-Host; Fail "docker compose up failed" }
                } else { $script:ComposeOut | Write-Host; Fail "docker compose up failed" }
            }
        }
    } finally { Pop-Location }
}

# --- native mode --------------------------------------------------------------------

function Ensure-Bun($app) {
    $bun = Join-Path $app ".tools\bun\bun.exe"
    if ((Test-Path $bun) -and ((& $bun --version) -eq $BunVersion)) { Ok "Bun $BunVersion"; return $bun }
    Step "Installing Bun $BunVersion (into .tools\bun)"
    $tmp = Join-Path $env:TEMP ("bun-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        Invoke-WebRequest -Uri "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/bun-windows-x64.zip" `
            -OutFile "$tmp\bun.zip" -UseBasicParsing -ErrorAction Stop
    } catch { Fail "Bun download failed: $($_.Exception.Message)" }
    Expand-Archive "$tmp\bun.zip" -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Path (Split-Path $bun) -Force | Out-Null
    Copy-Item (Get-ChildItem $tmp -Recurse -Filter bun.exe | Select-Object -First 1).FullName $bun -Force
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Ok "Bun $(& $bun --version)"
    return $bun
}

function Ensure-Ffmpeg {
    if (-not (Have ffmpeg)) { Winget-Install "Gyan.FFmpeg" "ffmpeg" }
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if (-not $cmd) { Fail "ffmpeg is installed but not on PATH yet. Open a new PowerShell window and re-run." }
    Ok "ffmpeg ($($cmd.Source))"
    return Split-Path $cmd.Source
}

# A python.org / winget Python 3.9-3.13 (not the Microsoft Store "python" stub).
function Find-Python {
    $tries = @()
    if (Have py) { foreach ($v in @("3.12", "3.11", "3.10", "3.13", "3.9")) { $tries += , @("py", "-$v") } }
    if (Have python) { $tries += , @("python") }
    foreach ($t in $tries) {
        $exe = $t[0]
        $rest = @($t | Select-Object -Skip 1)
        $out = & $exe @rest -c "import sys; print(sys.executable); print(int((3, 9) <= sys.version_info[:2] <= (3, 13)))" 2>$null
        if ($LASTEXITCODE -eq 0 -and $out.Count -ge 2 -and $out[1] -eq "1") { return $out[0] }
    }
    return $null
}

function Ensure-Python {
    $py = Find-Python
    if (-not $py) {
        Winget-Install "Python.Python.3.12" "Python 3.12"
        $py = Find-Python
    }
    if (-not $py) { Fail "Python 3.9-3.13 not found. Install it from python.org (tick 'Add to PATH'), then re-run." }
    Ok "Python ($py)"
    return $py
}

function Python-Venv($app, $py, $gpu) {
    $venvPy = Join-Path $app "ai-pipeline\.venv\Scripts\python.exe"
    Step "Python environment (ai-pipeline\.venv), a few minutes the first time"
    if (-not (Test-Path $venvPy)) {
        & $py -m venv (Join-Path $app "ai-pipeline\.venv") | Out-Host
        if ($LASTEXITCODE -ne 0) { Fail "Couldn't create the venv" }
    }
    # Out-Host: keep pip's output out of this function's return value.
    & $venvPy -m pip install -q --upgrade pip 2>&1 | Out-Null
    & $venvPy -m pip install -q -r (Join-Path $app "ai-pipeline\requirements.txt") | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "pip install failed" }
    $cudaDirs = ""
    if ($gpu) {
        # faster-whisper's GPU path needs cuBLAS + cuDNN 9 for CUDA 12; pip ships both (no CUDA install).
        & $venvPy -m pip install -q nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*" | Out-Host
        if ($LASTEXITCODE -ne 0) { Fail "pip install of the CUDA libraries failed (or re-run with -Cpu)" }
        $cudaDirs = (& $venvPy -c "import os, nvidia.cublas as b, nvidia.cudnn as c; print(';'.join(d for m in (b, c) for d in (os.path.join(p, s) for p in m.__path__ for s in ('bin', 'lib')) if os.path.isdir(d)))" | Out-String).Trim()
    }
    Ok "venv ready, yt-dlp $(& (Join-Path $app 'ai-pipeline\.venv\Scripts\yt-dlp.exe') --version)"
    return $cudaDirs
}

function Slash($p) { return $p -replace "\\", "/" }

# Settings for the native app; read by scripts\start.ps1. Kept on re-install.
function Write-NativeEnv($app, $gpu, $pathPrepend) {
    $envFile = Join-Path $app ".env.native"
    if (Test-Path $envFile) {
        $text = [IO.File]::ReadAllText($envFile)
        $text = $text -replace "(?m)^SERVER_PORT=.*$", "SERVER_PORT=$Port"
        $text = $text -replace "(?m)^PATH_PREPEND=.*$", "PATH_PREPEND=$pathPrepend"
        [IO.File]::WriteAllText($envFile, $text)
        Ok "Kept your settings in .env.native (port $Port)"
        return
    }
    $skip = "^(PYTHON_PATH|PIPELINE_DIR|DATA_DIR|SERVER_PORT|FFMPEG_PATH|YTDLP_PATH|WHISPER_DEVICE|FRONTEND_URL|SOROT_VERSION)="
    $defaults = Get-Content (Join-Path $app ".env.docker") | Where-Object { $_ -match "^[A-Z_]+=" -and $_ -notmatch $skip }
    $lines = @(
        "# Written by scripts/install.ps1: settings for the native app (scripts\start.ps1 reads them).",
        "# Edit, then Stop Sorot + Sorot from the Start menu. Options: README.md / .env.docker."
    ) + $defaults + @(
        "SERVER_PORT=$Port",
        "PYTHON_PATH=$(Slash (Join-Path $app 'ai-pipeline\.venv\Scripts\python.exe'))",
        "PIPELINE_DIR=$(Slash (Join-Path $app 'ai-pipeline'))",
        "DATA_DIR=$(Slash (Join-Path $app 'data'))",
        "STATIC_DIR=$(Slash (Join-Path $app 'frontend\out'))",
        "FFMPEG_PATH=ffmpeg",
        "YTDLP_PATH=$(Slash (Join-Path $app 'ai-pipeline\.venv\Scripts\yt-dlp.exe'))",
        "WHISPER_DEVICE=$(if ($gpu) { 'cuda' } else { 'cpu' })",
        "# Folders put in front of PATH for the app (venv, ffmpeg, CUDA libraries).",
        "PATH_PREPEND=$pathPrepend",
        "# Hosted LLM key (Groq, OpenRouter, OpenAI...); Ollama needs none. LLM_BASE_URL / LLM_MODEL are above.",
        "LLM_API_KEY="
    )
    [IO.File]::WriteAllText($envFile, (($lines -join "`r`n") + "`r`n"))
    Ok "Settings: .env.native"
}

function Install-Native($app) {
    $gpu = Gpu-Present
    if (-not $gpu) { Warn "No NVIDIA GPU in use: transcription and encoding run on the CPU (roughly 1 h per hour of video on 12 cores)" }
    $ffmpegDir = Ensure-Ffmpeg
    $bun = Ensure-Bun $app
    $py = Ensure-Python
    $cudaDirs = Python-Venv $app $py $gpu
    Step "Web UI (bun install + build)"
    Push-Location $app
    try {
        & $bun install --frozen-lockfile 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "bun install failed" }
        & $bun run build 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "UI build failed (run: .tools\bun\bun.exe run build)" }
    } finally { Pop-Location }
    Ok "frontend\out"
    Ensure-DataDirs $app
    if (-not $SkipModel) {
        Step "Downloading the Whisper model (large-v3-turbo, ~1.6 GB)"
        & (Join-Path $app "ai-pipeline\.venv\Scripts\python.exe") -c "from faster_whisper import WhisperModel; WhisperModel('large-v3-turbo', device='cpu', compute_type='int8')" 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Warn "Model download failed; it will download on the first import" } else { Ok "Whisper model cached" }
    }
    $prepend = @((Join-Path $app "ai-pipeline\.venv\Scripts"), $ffmpegDir, (Split-Path $bun))
    if ($cudaDirs) { $prepend += $cudaDirs }
    Write-NativeEnv $app $gpu ($prepend -join ";")
    if (-not $NoStart) {
        Step "Starting"
        & (Join-Path $app "scripts\start.ps1")
    }
}

# --- uninstall --------------------------------------------------------------------

function Uninstall-Sorot($app) {
    Step "Uninstalling Sorot from $app"
    if (Test-Path (Join-Path $app "scripts\stop.ps1")) { & (Join-Path $app "scripts\stop.ps1") }
    if ($Purge -and (Have docker) -and (Test-Path (Join-Path $app "docker-compose.yml"))) {
        Push-Location $app
        $null = Compose down --rmi all --volumes
        Pop-Location
        Ok "Removed the Docker image and model cache volume"
    }
    foreach ($f in @((Join-Path $StartMenu "Sorot.lnk"), (Join-Path $StartMenu "Stop Sorot.lnk"), $StartupLnk,
                     (Join-Path $app "docker-compose.override.yml"), (Join-Path $app ".env.native"))) {
        Remove-Item $f -Force -ErrorAction SilentlyContinue
    }
    Ok "Removed shortcuts and machine settings"
    if ($Purge) {
        foreach ($d in @("data", "ai-pipeline\.venv", ".tools")) { Remove-Item (Join-Path $app $d) -Recurse -Force -ErrorAction SilentlyContinue }
        Ok "Deleted data\, the venv and .tools\"
        if (-not (Test-Path (Join-Path $app ".git"))) { Remove-Item $app -Recurse -Force -ErrorAction SilentlyContinue; Ok "Deleted $app" }
    } else {
        Write-Host "Kept data\ (videos, clips, database). Use -Uninstall -Purge to delete it."
    }
    Write-Host "Docker Desktop, Python and ffmpeg were left installed."
}

# --- main --------------------------------------------------------------------

$code = 0
try {
    if ($Port -lt 1 -or $Port -gt 65535) { Fail "-Port must be 1-65535" }
    $app = Resolve-AppDir
    if ($Uninstall) {
        Uninstall-Sorot $app
    } else {
        Write-Host "Sorot installer - $Mode mode, port $Port, in $app" -ForegroundColor White
        $isCheckout = Test-Path (Join-Path $app ".git")
        if (-not $isCheckout) { Download-Source $app }
        if ($Mode -eq "docker") {
            Remove-Item (Join-Path $app ".env.native") -Force -ErrorAction SilentlyContinue  # start.ps1 runs native when it exists
            Install-Docker $app
        } else {
            Install-Native $app
        }
        Write-Shortcuts $app ($Mode -eq "native")
        Write-Host ""
        if (-not $NoStart) {
            if (Wait-Healthy 180) {
                Ok "Sorot is running: http://localhost:$Port  (studio: http://localhost:$Port/studio)"
                Start-Process "http://localhost:$Port/studio"
            } else {
                Warn "The app didn't answer on :$Port yet. Logs: $(if ($Mode -eq 'docker') { 'docker compose --env-file .env.docker logs backend' } else { 'data\logs\sorot.log' })"
            }
        }
        Write-Host "Start / stop: 'Sorot' and 'Stop Sorot' in the Start menu, or scripts\start.ps1 / scripts\stop.ps1 in $app"
        Write-Host "Update: re-run this installer."
    }
} catch {
    Write-Host " X  $($_.Exception.Message)" -ForegroundColor Red
    $code = 1
}
if ($PSCommandPath -and $code -ne 0) { exit $code }
