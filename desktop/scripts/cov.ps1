# Desktop coverage gate: cargo llvm-cov with the 95% gates and the ignore regex from cov-ignore.sh.
# Extra args pass through to cargo llvm-cov; exit code is llvm-cov's. Runs from any directory.
# With CARGO_TARGET_DIR set (a target dir shared by several workers) it holds <dir>\cov.lock first:
# llvm-cov wipes its llvm-cov-target at the start of every run, which cargo's own lock does not cover.
# The exclusive handle is released by the OS if this process dies, so the lock never goes stale.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Extra)
$desktop = Split-Path -Parent $PSScriptRoot
$handle = $null
if ($env:CARGO_TARGET_DIR) {
  New-Item -ItemType Directory -Force -Path $env:CARGO_TARGET_DIR | Out-Null
  $lockPath = Join-Path $env:CARGO_TARGET_DIR 'cov.lock'
  while (-not $handle) {
    try { $handle = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { Start-Sleep -Seconds 5 }
  }
}
try {
  Set-Location $desktop
  if (-not (Get-Command sh -ErrorAction SilentlyContinue)) {
    $env:PATH = (Join-Path $env:ProgramFiles 'Git\usr\bin') + ';' + $env:PATH
  }
  $ignore = (& sh (Join-Path $PSScriptRoot 'cov-ignore.sh')).Trim()
  & cargo llvm-cov --workspace --fail-under-lines 95 --fail-under-functions 95 --ignore-filename-regex $ignore @Extra
  $code = $LASTEXITCODE
} finally { if ($handle) { $handle.Close() } }
exit $code
