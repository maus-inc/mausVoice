# UI verification

The scripts in `scripts/verify/` capture the real desktop settings, help, and microphone components in the preview app. The harness fakes only the native Tauri bridge at `__TAURI_*_INTERNALS__`. It does not replace or mock the React components.

The verification harnesses import the desktop font faces and tokens, and mount the production MUI theme. Keep those imports in `apps/preview/verify-harness/settings.tsx` and `apps/preview/verify-harness/help.tsx`. The capture is not valid if Satoshi fails to load or if MUI's spacing variables are missing. Check `document.fonts.check('16px Satoshi')` and computed spacing before taking screenshots.

## Compare a change

A useful visual comparison answers a question, not just fills a screenshot quota. Capture the **same real route, viewport, theme, browser build, and seeded state** on the exact base and PR-head commits. Select pages with the changed behavior and representative content: include mixed controls, descriptions, segmented choices, and page-specific states—not only pages whose cards are mostly switches. For Settings layout work, Appearance is a useful example because it shows the **Reset pill position** setting and its Current monitor / Cursor monitor choices; AI and models and Shortcuts show different control/content shapes. Capture at least one viewport near the reported width and, when a breakpoint changes, a width on each side of that transition.

Use detached worktrees so the active PR branch is never switched or rewritten. Record both SHAs in the comparison note. Restart Vite whenever changing trees; a hot server can retain modules from the previous tree. If a preview dependency has no built workspace entry point, build its dependency chain in that worktree (for example, `pnpm --filter @repo/agent... build`). Verify the served route and title before trusting a capture.

```bash
BASE_SHA=<exact-base-commit>
HEAD_SHA=<exact-pr-head-commit>
git worktree add --detach /tmp/ui-before "$BASE_SHA"

# In the base worktree: install locked deps if needed, then start the preview.
cd /tmp/ui-before
corepack pnpm install --offline --frozen-lockfile
corepack pnpm --filter @repo/agent... build  # only if the preview reports missing workspace dist entries
corepack pnpm --filter @maus-inc/preview dev

# In another shell, use the capture script from the PR checkout. Repeat for each
# theme, and use identical values on base and head. The 900px example captures
# content-rich routes in addition to controls made mostly of switches.
SETTINGS_VIEWPORTS=900x900 SETTINGS_PAGES=appearance,ai-models,shortcuts \
  THEME=light OUT_DIR=/tmp/ui-shots/before-light \
  node scripts/verify/shot-settings.mjs
THEME=dark OUT_DIR=/tmp/ui-shots/before-dark \
  SETTINGS_VIEWPORTS=900x900 SETTINGS_PAGES=appearance,ai-models,shortcuts \
  node scripts/verify/shot-settings.mjs

# Stop the base preview, start it from the PR-head checkout, and repeat with
# OUT_DIR=/tmp/ui-shots/after-light and /tmp/ui-shots/after-dark.

# Compose matched full-size pairs outside the repository; pin them in one commit,
# embed their raw/<pin-sha>/... URLs in the PR description, and delete them in the
# immediately following commit so review artifacts never land in the base branch.
montage -background '#101216' -fill '#f5f5f5' -font DejaVu-Sans -pointsize 18 \
  -label "BASE ${BASE_SHA:0:7} · Appearance · light · 900x900" \
  /tmp/ui-shots/before-light/settings-900-appearance.png \
  -label "HEAD ${HEAD_SHA:0:7} · Appearance · light · 900x900" \
  /tmp/ui-shots/after-light/settings-900-appearance.png \
  -tile 2x1 -geometry '900x900+12+38' \
  /tmp/ui-shots/appearance-light-before-after.png
```

`shot-settings.mjs` defaults to all eight pages at the supported 1280×900, 1100×700, and 800×600 sizes. `SETTINGS_VIEWPORTS=WIDTHxHEIGHT,...` and `SETTINGS_PAGES=route,...` narrow or extend the capture matrix for a specific review; valid route ids are `home`, `dictation`, `ai-models`, `shortcuts`, `appearance`, `privacy-data`, `system`, and `account`. `THEME` selects one scheme and `OUT_DIR` keeps temporary screenshots and geometry JSON outside the source tree. The script verifies the rendered heading, Satoshi font, MUI spacing token, layout geometry, and browser errors; inspect each selected image at full resolution too.

Do not leave per-PR screenshots, transient per-route PNGs, raw measurements, browser profiles, duplicate screenshot matrices, or per-PR Markdown verification docs in the final PR tree under `docs/visual-verification/` or `docs/assets/` — they bloat the PR and do not need to land in the base branch. Follow the pin-then-delete flow in `docs/visual-verification/README.md`: commit the final comparison images on the PR branch to pin them at a full SHA (`<pin-sha>`), embed those `raw/<pin-sha>/...` Markdown image links above the folds in the PR description, delete the temporary image files in the immediately following commit, and repeat that pin-and-delete cycle whenever subsequent UI changes occur. Put the verification record (base/head SHAs, pinned screenshot SHA, viewport/theme matrix, browser version, what the harness fakes, layout measurements, what was visually checked, and any limitations) inside a folded `<details><summary>Visual verification</summary>` block in the PR description rather than committing a Markdown file to `docs/visual-verification/`; do not claim native-app behavior from the preview harness.

## Run the verification scripts

Install the pinned Chromium once, then start the preview app on port 5193. The scripts do not start the server themselves. On a restricted Linux x86-64 host where `install-chromium.mjs` cannot reach npm or where the full capture stack (`ffmpeg`, `ffprobe`, `gifsicle`, `tesseract`, Chromium) is needed, use `system/tools/bin/chromium` from `vendor/sandbox-toolchain` per `engineering/sandbox-vendored-toolchain.md`.

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

The settings capture defaults to light mode. Set `THEME=dark` to check the other scheme. `OUT_DIR` controls where screenshots and geometry JSON are written; by default they go to `mausvoice-ui-verify` under the operating system's temporary directory, outside the repository. Inspect every image at full size before adding it to a pull request. Check that the bundled Satoshi font rendered, spacing looks normal, the correct page and theme appear, and no content clips or overflows.

`click-settings.mjs` exercises the eight-page rail, active-page state, settings search (matching and empty results), slash/Escape keyboard behavior, and the Overview actions in both themes. It also checks that rendered switches expose their state and accessible labels, and tabs expose selection. This harness intentionally stubs Tauri and does not mount the full app shell, so global dialogs and preference persistence are verified by the desktop component tests rather than by this click-through.

For group actions, compare the action's measured right edge with the first row's content edge in the geometry JSON emitted to `OUT_DIR`; the values should match. Keep generated measurement dumps outside the tree and follow the pin-then-delete screenshot flow in `docs/visual-verification/README.md` so no PR-only images or verification records land in the base branch.

`shot-help.mjs` checks `HelpPage`, sibling `DictionaryPage` heading alignment, and live `TipCard` rendering at `1280x900`, `1100x700`, `800x600`, and `560x700` in light and dark themes. It verifies `document.fonts.check('16px Satoshi')`, `--app-spacing`, applied `data-mui-color-scheme`, served tree markers (`[data-tip-title="true"]` on head vs absent on `EXPECTED_TREE=base`), unrounded WCAG AA contrast (`>= 4.5`), card rail alignment, and zero overflow, writing geometry JSON into `OUT_DIR`. `click-help.mjs` verifies `Show again`, gated assistant routing (`off` and `on`), live `TipCard` in-page action and keyboard dismissal, target sizes, keyboard Tab focus traversal with `:focus-visible`, and `320px` reflow, clipped-text, RTL, and tripled-text viewport stress in both themes.
