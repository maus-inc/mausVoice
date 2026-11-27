# UI verification

The scripts in `scripts/verify/` capture the real desktop settings, help, and microphone components in the preview app. The harness fakes only the native Tauri bridge at `__TAURI_*_INTERNALS__`. It does not replace or mock the React components.

The verification harnesses import the desktop font faces and tokens, and mount the production MUI theme. Keep those imports in `apps/preview/verify-harness/settings.tsx` and `apps/preview/verify-harness/help.tsx`. The capture is not valid if Satoshi fails to load or if MUI's spacing variables are missing. Check `document.fonts.check('16px Satoshi')` and computed spacing before taking screenshots.

## Compare a change

The pull request should include before and after captures, side by side, for the pages and widths affected. Save the comparison images under `reports/ui-verify/settings-compare/`. That directory and the light/dark layout JSON reports are intentionally tracked. Other screenshots and JSON measurements in `reports/ui-verify/` follow the repository's existing ignore rules.

```bash
# Start the preview server after checking out each tree. Vite caches modules.
pnpm --filter @maus-inc/preview dev --port 5193

# Capture the base tree, then the working tree after restarting the server.
OUT_DIR=/tmp/shots/before node scripts/verify/shot-settings.mjs
OUT_DIR=/tmp/shots/after node scripts/verify/shot-settings.mjs

# Build one image per page and width from its before and after captures.
montage -background '#0f1012' -fill '#f4f4f5' -font DejaVu-Sans -pointsize 20 \
  -label "Before: base branch" /tmp/shots/before/settings-1100-dictation.png \
  -label "After: working branch" /tmp/shots/after/settings-1100-dictation.png \
  -tile 2x1 -geometry '+16+16' reports/ui-verify/settings-compare/1100-dictation.png
```

Restart the preview server between trees. A running Vite process can serve cached modules after a bulk checkout. Confirm the served tree before trusting a capture. The current settings rows expose `.setting-row-label`; the base version does not.

## Run the verification scripts

Install the pinned Chromium once, then start the preview app on port 5193. The scripts do not start the server themselves.

```bash
node scripts/verify/install-chromium.mjs
pnpm --filter @maus-inc/preview dev --port 5193
node scripts/verify/shot-home.mjs
node scripts/verify/shot-mic-dialog.mjs
node scripts/verify/shot-settings.mjs
THEME=light node scripts/verify/click-settings.mjs
THEME=dark node scripts/verify/click-settings.mjs
node scripts/verify/shot-help.mjs
THEME=dark node scripts/verify/shot-help.mjs
node scripts/verify/click-help.mjs
node scripts/verify/sweep-preview.mjs
```

| Script                | URL variable                  | Default                                                |
| --------------------- | ----------------------------- | ------------------------------------------------------ |
| `shot-home.mjs`       | `PREVIEW_URL`                 | `http://127.0.0.1:5193`                                |
| `sweep-preview.mjs`   | `argv[2]`, then `PREVIEW_URL` | `http://127.0.0.1:5193`                                |
| `shot-mic-dialog.mjs` | `HARNESS_URL`                 | `http://127.0.0.1:5193/verify-harness/mic-dialog.html` |
| `shot-settings.mjs`   | `HARNESS_URL`                 | `http://127.0.0.1:5193/verify-harness/settings.html`   |
| `shot-help.mjs`       | `HARNESS_URL`                 | `http://127.0.0.1:5193/verify-harness/help.html`       |
| `click-help.mjs`      | `HARNESS_URL`                 | `http://127.0.0.1:5193/verify-harness/help.html`       |

`shot-settings.mjs` checks eight settings pages at 1280x900, 1100x700, and the 800x600 minimum. It records page, row, heading, and action geometry in `settings-layout.json` and exits nonzero when its layout checks or browser console checks fail. Group headings sit above their cards at the card's left edge. Row labels keep their own leading slot, and a group action aligns with the row content edge. The distinction is deliberate: the heading names the whole group; the action is a control in that group.

The settings capture defaults to light mode. Set `THEME=dark` to check the other scheme, and set `OUT_DIR` to write temporary captures outside the repository. Inspect every image at full size before adding it to a pull request. Check that the bundled Satoshi font rendered, spacing looks normal, the correct page and theme appear, and no content clips or overflows.

`click-settings.mjs` exercises the eight-page rail, active-page state, settings search (matching and empty results), slash/Escape keyboard behavior, and the Overview actions in both themes. It also checks that rendered switches expose their state and accessible labels, and tabs expose selection. This harness intentionally stubs Tauri and does not mount the full app shell, so global dialogs and preference persistence are verified by the desktop component tests rather than by this click-through.

The Overview action-edge correction is compared before/after in both themes at all three supported widths under `reports/ui-verify/settings-compare/action-alignment-*`. The geometry JSON records each action's right edge and the first row's content edge; those values must match.

`shot-help.mjs` checks `HelpPage`, sibling `DictionaryPage` heading alignment, and live `TipCard` rendering at `1280x900`, `1100x700`, `800x600`, and `560x700` in light and dark themes. It verifies `document.fonts.check('16px Satoshi')`, `--app-spacing`, applied `data-mui-color-scheme`, served tree markers (`[data-tip-title="true"]` on head vs absent on `EXPECTED_TREE=base`), unrounded WCAG AA contrast (`>= 4.5`), card rail alignment, and zero overflow, writing `help-layout.json` and `help-layout-dark.json` to `OUT_DIR` (default `reports/ui-verify/`). `click-help.mjs` verifies `Show again`, gated assistant routing (`off` and `on`), live `TipCard` in-page action and keyboard dismissal, target sizes, keyboard Tab focus traversal with `:focus-visible`, and `320px` reflow, clipped-text, RTL, and tripled-text viewport stress in both themes.
