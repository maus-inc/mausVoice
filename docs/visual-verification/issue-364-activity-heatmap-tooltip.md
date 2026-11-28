# Activity heatmap tooltip pointer interaction: visual verification

Issue #364 fixes hover interference on the Home activity heatmap (`ActivityHeatmap`).
Previously, each cell's MUI `Tooltip` rendered an interactive popper (`pointer-events: auto`)
with default `100ms` enter delay and `200ms` Grow exit duration. Because each heatmap cell is
a `10px x 10px` square (`4px` gap), the tooltip above a hovered cell covered roughly three
rows and thirteen columns above it, intercepting upward pointer movement and leaving stacked
fading tooltips during rapid sweeps.

## Capture environment

- Surface: desktop browser preview (`pnpm --filter desktop dev:preview`), real Home route
  `/?scenario=populated&previewPopup=hidden`
- Viewport: `1157x727` CSS pixels, `deviceScaleFactor: 2`
- Browser: Chromium `153.0.8010.0` driven via `scripts/verify/cdp.mjs`
- Schemes and motion modes checked: dark (`no-preference`), light (`no-preference`), and dark
  (`prefers-reduced-motion: reduce`)
- Base commit: `5929c44` (`arena/0.1.6-consolidation`)

## Committed evidence

| File | State |
| --- | --- |
| `docs/assets/issue-364-heatmap-tooltip-before.dark.png` | Base `5929c44`, dark: pointer moved from `Nov 28` straight up to `Nov 27`; `.MuiTooltip-arrow` intercepts the pointer so `Nov 27` never highlights and the tooltip stays stuck on `Nov 28, 2026: 612 words`. |
| `docs/assets/issue-364-heatmap-tooltip-after.dark.png` | After fix, dark: exact same pointer move from `Nov 28` straight up to `Nov 27`; `Nov 27` highlights immediately and the tooltip updates to `Nov 27, 2026: 316 words`. |
| `docs/assets/issue-364-heatmap-tooltip-after.light.png` | After fix, light: exact same pointer move from `Nov 28` straight up to `Nov 27`; `Nov 27` highlights immediately and the tooltip updates to `Nov 27, 2026: 316 words`. |

## Measured DOM results

| Check | Base (`5929c44`) | After fix |
| --- | --- | --- |
| Popper `pointer-events` while open | `auto` (`.MuiTooltip-popperInteractive`) | `none` (no interactive class) |
| `document.elementFromPoint` at `Nov 27` while `Nov 28` is hovered | `SPAN.MuiTooltip-arrow` (`[role="tooltip"]`) | `[data-testid="activity-day"][data-date="2026-11-27"]` |
| Tooltip after stepping straight up `Nov 28 -> Nov 27` | Stuck on `Nov 28, 2026: 612 words` | `Nov 27, 2026: 316 words` |
| Tooltip after continuing up `Nov 27 -> Nov 26` | Stuck on `Nov 28, 2026: 612 words` | `Nov 26, 2026: 1,042 words` |
| Peak simultaneous `[role="tooltip"]` during rapid 20ms/cell horizontal sweep | `3` overlapping tooltips | `1` (zero overlap or ghosting) |
| Peak simultaneous `[role="tooltip"]` during 1px vertical crawl across the 4px gap | Blocked by tooltip | `1`, cleanly transitions to `Nov 27` |
| Pointer leaves heatmap | `0` tooltips after ~200ms exit fade | `0` tooltips immediately |
| `Escape` key dismissal | `0` tooltips | `0` tooltips |
| `prefers-reduced-motion: reduce` | `200ms` Grow animation | `0ms` enter/exit, positioned cleanly above `Nov 28` (`rect.y=295.4`), `Nov 27` (`rect.y=281.4`), and `Nov 26` (`rect.y=267.4`) |
| Keyboard focus (`tabIndex={0}` region) and screen-reader list (`370` daily items) | Present | Unchanged |
