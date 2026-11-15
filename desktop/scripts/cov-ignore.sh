#!/bin/sh
# Prints the --ignore-filename-regex for cargo llvm-cov: every path in coverage-exclude.txt with a
# literal dot and a [/\] class for the separator, so Windows paths match too. Same on Linux and Git Bash.
tr -d '\r' < "$(dirname "$0")/../coverage-exclude.txt" | sed -e 's/\./\\./g' -e 's#/#[/\\]#g' | paste -sd'|' -
