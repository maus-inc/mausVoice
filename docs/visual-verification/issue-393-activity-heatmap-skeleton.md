# Issue #393: Activity Heatmap Skeleton Loading State

Visual verification record for replacing the Home `ActivityHeatmap` `LinearProgress` bar with a geometry-matched skeleton placeholder.

## Capture environment

- Preview app: `pnpm --filter desktop run dev:preview` (`http://127.0.0.1:1420/dashboard?scenario=active&previewPopup=hidden`)
- Browser: headless Chromium `153.0.8010.0` via `scripts/verify/cdp.mjs`
- Baseline (before): `8619b7a8e687e7e829373b35361bdef29e389890` (`arena/0.1.6-consolidation`)
- Viewports: desktop `1157x727` DPR `2` (`>= 560px` Home container) and compact `460x844` DPR `2` (`< 560px` Home container)
- Color schemes: light (`#F5F2ED` parchment, `#E0DBD2` skeleton fill) and dark (`#0C0C0D` obsidian, `#2A2A2C` skeleton fill)

## Layout stability measurements (loading to loaded)

| Viewport & theme | Metric | Before (`8619b7a`, `LinearProgress`) | After (skeleton) |
| --- | --- | --- | --- |
| Desktop `1157x727` (light & dark) | Heatmap section height | `62px -> 162px` (`+100.00px`) | `162px -> 162px` (`0.00px`) |
| Desktop `1157x727` (light & dark) | Heatmap section `y` | `290.42px -> 240.42px` (`-50.00px`) | `240.42px -> 240.42px` (`0.00px`) |
| Desktop `1157x727` (light & dark) | Legend `y` | `342.42px -> 392.42px` (`+50.00px`) | `392.42px -> 392.42px` (`0.00px`) |
| Desktop `1157x727` (light & dark) | Weekday rail & viewport rect | Absent while loading | `0.00px` delta (`scrollLeft: 500 -> 500`) |
| Compact `460x844` (light & dark) | Analytics grid height | `210.53px -> 310.53px` (`+100.00px`) | `310.53px -> 310.53px` (`0.00px`) |
| Compact `460x844` (light & dark) | Heatmap section height | `32px -> 132px` (`+100.00px`) | `132px -> 132px` (`0.00px`) |
| Compact `460x844` (light & dark) | Surrounding metric cards (`streak`, `month`, `total`, `speed`) | `0.00px` | `0.00px` |

## Additional checks

- Progress bar inside `[data-testid="home-activity-heatmap"]`: `false` during `idle` and `loading`.
- Cell count: `371` skeleton cells (`53` weeks x `7` weekday rows) transitioning to `371` interactive day cells; future cells in the final week stay transparent.
- Accessibility: outer `<section>` sets `aria-busy="true"` while loading and clears it on load; inner wrapper exposes `role="status"` labelled `Loading daily activity`; decorative skeleton grid and legend carry `aria-hidden="true"` with no focusable controls.
- Reduced motion: Chromium with `prefers-reduced-motion: reduce` reported `animationName: "none"` on both `activity-heatmap-skeleton-grid` and `activity-heatmap-legend-skeleton`.
- Empty (`[]`, `success`) and error (`error`) states render the empty grid with `"Your dictation activity will appear here."` and `"Daily activity could not be loaded."` respectively.
- Console errors: `0`; horizontal page overflow: `false`.

## Screenshots

- Before desktop light: `docs/assets/issue-393-heatmap-loading-before.light.png`
- Before desktop dark: `docs/assets/issue-393-heatmap-loading-before.dark.png`
- After desktop light: `docs/assets/issue-393-heatmap-loading-after.light.png`
- After desktop dark: `docs/assets/issue-393-heatmap-loading-after.dark.png`
- After compact light: `docs/assets/issue-393-heatmap-loading-compact-after.light.png`
