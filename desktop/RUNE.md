# Rune pin

Rune is pre-release, so the app pins one revision and bumps it on purpose.

- Repository: https://github.com/anomalyco/rune
- Revision: `73b7dec296e6c1284ebdf8af53f544444611c0ae` (the `rev` on every Rune dependency and every patch in `Cargo.toml`)
- Crates: `rune`, `rune-kit`, `rune-motion`, `rune-fx`, `rune-i18n`, `rune-notify`

## Patches

A dependency's `[patch]` does not apply to the workspace that depends on it, so the root
`Cargo.toml` repeats each entry of Rune's own `[patch.crates-io]` at the same rev. Rune keeps them
as `path = "vendor/..."`; here they are the git form its README gives for apps.

| Crate | Why |
|---|---|
| `winit` | A new window is not added again to the taskbar it is already on; a positioned window is born at that display's scale |
| `parley_engine` | Bidi rule L1 for trailing whitespace and isolates; shaping that stops redoing work |
| `wgpu-hal` | DXGI adapter pick on DX12, FXC loaded on first compile, partial presents |
| `accesskit_windows` | Headings and landmarks reach UI Automation (Narrator, NVDA) |
| `accesskit_macos` | Headings reach NSAccessibility as `AXHeading` (VoiceOver) |

## Bump procedure

1. Open Rune's root `Cargo.toml` at the new rev; compare its `[patch.crates-io]` with ours and add, drop or change entries.
2. Change the rev on every Rune dependency and every patch in one commit, in its own change.
3. Run the full gate on Windows, macOS and Linux (`/test`, including snapshots and Kani).
4. Add a line to the log below.

## Bump log

| Date | From | To | Notes |
|---|---|---|---|
