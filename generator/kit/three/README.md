# three (built-in kit part)

`three.min.js` is Three.js r159 (`three@0.159.0` on npm, MIT, `LICENSE-three.txt`), the last release
that ships a plain browser build. Vendored so renders stay offline. One change: the build's opening
`console.warn(...)` about the deprecated build is replaced by `0,` (so `check` reports no console
warning). Tarball checked against npm's integrity hash
`sha512-eCmhlLGbBgucuo4VEA9IO3Qpc7dh8Bd4VKzr7WfW4+8hMcIfoAVi1ev0pJYN9PTTsCslbcKgBwr2wNZ1EvLInA==`.
The version is also recorded in `generator/package.json` (`vendored.three`).
