# Issue 368 — Chromium visual verification

**Verified code tree:** `975eaba53dd8373f868f23781c8e8c495ddf474e` (PR #387, after incorporating current target commit `15ef92dc78d997ecccd744c52133ed347119df42`)
**Evidence commit:** added screenshots and reports only; no app code changed after the verified tree.
**Browser:** pinned vendor Chromium `156.0.8078.79` from vendor payload commit `3025c92b50c9d8977941b689a779068997896d38`.
**Surface:** repository Settings verification harness, mounting the real desktop `SettingsLayout` and Settings pages; only the Tauri bridge is faked.

## Evidence

- `standard/light/` and `standard/dark/`: 12 retained reference screenshots—Shortcuts and AI and models at `1280×900`, `1100×700`, and `800×600` in both themes. The complete documented run captured all eight destinations (48 total); the two geometry reports retain that full coverage.
- `breakpoint/responsive-matrix.json`: 32 measured cases for Shortcuts and AI and models in both themes at `800`, `900`, `934`, `935`, `936`, `940`, `950`, and `1000` px. Redundant per-case PNGs were removed after review.
- `../settings-layout.json` and `../settings-layout-dark.json`: full geometry reports from `shot-settings.mjs` for both themes, 24 cases each.

## Findings

- The complete standard run rendered all 48 destination/theme/size combinations; 12 representative screenshots are retained. The harness verified Satoshi loaded and MUI spacing was available; layout reports have no problems, console errors, or failed requests.
- No horizontal document overflow at any of the documented sizes. At `800×600`, the compact navigation wraps above the page and the page content continues in the intended vertically scrollable pane; at `1100×700` and `1280×900`, navigation stays in the rail and content remains in its own column.
- The additional width sweep measured the transition: compact column/wrapped navigation at `935px`, wide row/non-wrapping rail at `936px`; no horizontal overflow at any tested width.
- Full-size screenshot review covered every destination in both themes at the minimum width, every destination in dark mode at all three standard widths, and representative light-mode pages at the wider widths. The active navigation item, search control, headings, cards, and controls remain legible and aligned. Long pages continue below the viewport in the intended scroll pane; no horizontal clipping was observed. The Overview's `Loading` shortcut summary is the harness's documented empty-user-data state.
- `click-settings.mjs` passed in light and dark: all eight rail destinations and active states, matching and empty search, slash/Escape behavior, both Overview links, 14 accessible switches, and 9 tabs.

The regular `shot-settings.mjs` reports were generated with the repository's documented Chromium scripts; the extended width sweep was an additional CDP capture using the same vendored browser. The 12 retained screenshots are representative visual references; both full geometry reports and the extended matrix remain available for inspection.
