# Dot-sourced by install.ps1 and start.ps1: writes this machine's
# docker-compose.override.yml (gitignored). docker-compose.yml runs the CPU
# image; with an NVIDIA GPU this switches to the -cuda image and reserves the GPU.

$SorotCudaBase = "nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04"   # backend/Dockerfile BASE_IMAGE for -Build

function Write-SorotOverride {
    param([string]$Root, [int]$Port, [bool]$Gpu, [string]$Writer)
    $lines = @(
        "# Written by $Writer for this machine (gitignored).",
        "services:",
        "  backend:",
        "    restart: unless-stopped",
        "    ports: !override",
        "      - `"${Port}:8080`""
    )
    if ($Gpu) {
        $lines += @(
            # Single quotes: ${SOROT_VERSION} is for compose to fill in.
            '    image: ghcr.io/raufimusaddiq/sorot:${SOROT_VERSION:-latest}-cuda',
            "    build:",
            "      args:",
            "        BASE_IMAGE: $SorotCudaBase",
            "    environment:",
            "      WHISPER_DEVICE: cuda",
            "    deploy:",
            "      resources:",
            "        reservations:",
            "          devices:",
            "            - driver: nvidia",
            "              count: 1",
            "              capabilities: [gpu]"
        )
    }
    # UTF-8 without BOM: compose rejects a BOM at the start of YAML on some versions.
    [IO.File]::WriteAllText((Join-Path $Root "docker-compose.override.yml"), (($lines -join "`n") + "`n"))
}
