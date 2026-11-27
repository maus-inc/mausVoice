# Maximized title-bar restore — visual verification

Issue #354 changes what happens when the title bar of a maximized window is
dragged: the window restores under the pointer and keeps moving. That is a
pointer behaviour, and a still frame cannot show a gesture. What a frame *can*
show is the claim that nothing about the bar's appearance moved — the drag
region, the theme toggle, the logo tile, the wordmark and the three caption
buttons — because the three press handlers were refactored out of
`apps/desktop/src/components/root/TitleBar.tsx` into a hook, and a refactor that
recomputes geometry is exactly what a diff hides.

This report records what was captured, what it showed, and the one measurement
that made the change visible.

## Method

Surface: the app chrome at the top of the desktop preview
(`apps/desktop/src/components/root/TitleBar.tsx`).

- Server: `pnpm --filter desktop dev:preview` (port 1420, `--mode preview`), the
  real components over the mocked Tauri layer.
- Base tree: a worktree at `0f15abe5d4ff8b17685d931e70e46d35f9bbda58`, the
  branch's actual base, served on port 1421 with its own Vite config. Frames
  labelled `base` come from that tree, not from switching a flag off in the head.
- Browser: `node scripts/verify/install-chromium.mjs --dir /tmp/chr` (Chromium
  153.0.8010.0), driven by `puppeteer-core` from `/tmp/shot/capture.mjs`. Nothing
  added to the repository.
- Viewport: 1157×727 at device scale factor 2, `prefers-reduced-motion: reduce`,
  `?previewPopup=hidden`, and every tip card dismissed and asserted gone before
  the shutter.
- Both colour schemes captured; the dark frames are what the pull request
  description shows.

## What the frames show

| Frame | Commit | Scheme |
| --- | --- | --- |
| `docs/assets/titlebar-drag-restore/base-titlebar.dark.png` | `0f15abe5` | dark |
| `docs/assets/titlebar-drag-restore/head-titlebar.dark.png` | `1895a183` | dark |

Both frames, full width and magnified 6× over the left 55 CSS pixels, were
inspected. The upper-left corner — where the theme toggle ring, the logo tile and
the wordmark meet — is the region the checklist calls out, and it reads
identically: the ring is a true circle at the same optical weight, the tile is
level with it, and the wordmark baseline is unchanged. The three caption buttons
sit at the same offsets. The full-bleed drag region between the wordmark and the
caption cluster is empty in both, which is the surface the gesture now uses.

## The measurement

`getBoundingClientRect` on the bar and its controls, read in the same script that
took the frames:

| | base `0f15abe5` | head `1895a183` |
| --- | --- | --- |
| Title bar | 1157 × 40 at (0, 0) | 1157 × 40 at (0, 0) |
| Caption buttons | 34 × 34 at x = 1049, 1085, 1121 | 34 × 34 at x = 1049, 1085, 1121 |
| Caption cluster top | y = 2.5 | y = 2.5 |

No geometry changed. That is the expected result for this diff and the reason
the frames are worth attaching: the numbers say the layout is untouched, and the
frames show it.

## What looked wrong, and what it was

A pixel diff of the two dark frames reported 682 differing pixels, 0.368% of the
crop, with a maximum channel delta of 35, all confined to CSS x 12–40 — the
theme-toggle ring. That looks like a real defect in a frame pair.

It is not caused by this change. Capturing the **base tree twice** in the same
session gives 731 and 595 differing pixels in the same x range, which is *more*
difference between two runs of unchanged code than between base and head (286
pixels). The ring is a rendered gradient with subpixel antialiasing that does not
reproduce byte-for-byte across runs on this software rasteriser. The honest
reading is that this surface is not stable enough to judge by pixel diff, so the
judgement rests on looking at the magnified frames and on the geometry table,
both of which agree.

Nothing in the code was changed for this. Tuning a component so that a
screenshot diff comes out clean would be changing code to please a measurement
that has no repeatability.

## Not captured, and why

- **The gesture itself.** Dragging a maximized title bar needs a native window.
  The preview has no real window to maximize, and no Tauri move loop to hand the
  drag to. The behaviour is covered by `apps/desktop/src/components/root/useWindowDrag.test.ts`
  at the DOM boundary, and the remaining gap — the OS move loop continuing from
  the placed position — needs Windows hardware and is stated as such in the pull
  request.
- **Touch and pen.** No fixtures drive a pointer type other than mouse.
- **Screen readers.** The bar's accessible names are unchanged by this diff
  (`TitleBar.test.tsx` still asserts them) and no native screen reader was run
  here, which is the same gap the generated `apps/preview/specs/titlebar.md` has
  always recorded.

## Manual flow a person can follow

1. Sign in to a maximized window on Windows or Linux.
2. Press on the empty middle of the title bar and drag sideways 20px.
3. The window should restore at its previous size and width, with the grabbed
   point still under the pointer, and keep following it.
4. Release. Press again and drag; the window should move from where it is.
5. Double-click the same bar: it should toggle maximize, not restore twice.
