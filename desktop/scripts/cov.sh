#!/bin/sh
# Desktop coverage gate: cargo llvm-cov with the 95% gates and the ignore regex from cov-ignore.sh.
# Extra args pass through to cargo llvm-cov; exit code is llvm-cov's. Runs from any directory.
# With CARGO_TARGET_DIR set (a target dir shared by several workers) it holds flock on
# $CARGO_TARGET_DIR/cov.lock first: llvm-cov wipes its llvm-cov-target at the start of every run,
# which cargo's own lock does not cover. The kernel drops the lock if this process dies.
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/.." || exit 1
run() {
  cargo llvm-cov --workspace --fail-under-lines 95 --fail-under-functions 95 \
    --ignore-filename-regex "$(sh "$here/cov-ignore.sh")" "$@"
}
if [ -n "$CARGO_TARGET_DIR" ]; then
  mkdir -p "$CARGO_TARGET_DIR" || exit 1
  exec 9>"$CARGO_TARGET_DIR/cov.lock"
  flock 9 || exit 1
fi
run "$@"
