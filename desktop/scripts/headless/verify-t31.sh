#!/usr/bin/env bash
# One local verify pass for T-31: clippy, the full suite binary, and core unit tests.
set -u
cd "$(dirname "$0")/../.."
mkdir -p design/verify-logs
run() {
  name="$1"; shift
  echo "== $name: $* =="
  "$@" >"design/verify-logs/$name.log" 2>&1
  s=$?
  echo "exit=$s"
  tail -8 "design/verify-logs/$name.log"
}
run clippy cargo clippy --all-targets -- -D warnings
run suite cargo test --test suite
run core cargo test -p sorot-desktop-core
