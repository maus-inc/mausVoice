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

## The gesture, driven in a real browser

The screenshots above say what the bar looks like. This section is about what it
*does*, which is the part a frame cannot show.

The preview renders the real `TitleBar`, so the gesture can be driven in a real
Chromium with a real mouse. The one thing it lacks is a native window, and that
turns out to be replaceable rather than unbridgeable: `isTauriRuntime()` is a
test for `window.__TAURI_INTERNALS__`, so installing that object — the same seam
`apps/preview/verify-harness/fake-tauri.ts` already uses — makes the real
`@tauri-apps/api` take its native path. Every window command is then a genuine
IPC call dispatched by the real `useWindowDrag`, which the harness records and
answers. Nothing in the component is mocked, and the assertions are made against
the calls the hook actually issued, in the order it issued them.

Driven with `puppeteer-core` over the DevTools protocol, pressing at 300px along
a 1920px maximized bar and dragging 40px, the hook issued:

```
inner_size → scale_factor → event|listen → unmaximize → event|unlisten
→ inner_size → cursor_position → scale_factor → current_monitor
→ available_monitors → set_position → start_dragging
```

and placed the window at `(119.21875, 0)`. That number is checkable by hand:
the grab is 300/1920 = 15.625% of the width, and 15.625% of the restored 1157px
is 180.78, so x = 300 − 180.78 = 119.22. The grab point is the same fraction of
the window before and after the resize, which is exactly what "restores under
the pointer" means. The position is sent as `Logical`, matching what
`setPosition` expects.

Five scenarios were run against this head and against the base commit, with
identical harness and gestures:

| Scenario | Base `5929c44` | Head `5125ec7` |
| --- | --- | --- |
| Maximized, press then drag | restores nothing; only `start_dragging` | unmaximize → place → drag, math exact |
| Already restored (control) | plain drag | plain drag |
| Window manager never reports the resize | never restores | places after a ~538ms settle, then drags |
| Button released during the restore | drags anyway | restores, and does **not** start a drag |
| Press lands before the first `is_maximized` answer | drags without restoring | re-reads live, restores |

The control matters as much as the first row: it passes on both commits, so the
first row's failure on base is the feature being absent rather than the test
being unable to see anything. Two results are worth naming because they are the
fixes from the review rounds, seen from outside the unit tests: the settle
allowance is spent *waiting* rather than racing (placement at ~538ms when the
WM stays silent), and a release inside that wait leaves the window restored but
the move loop unarmed.

## Not captured, and why

- **The OS move loop.** Everything up to `start_dragging` is verified above,
  but the command itself is answered by the harness. Whether Windows continues
  the drag from the placed position is `tao`'s `ReleaseCapture` →
  `WM_NCLBUTTONDOWN` with `HTCAPTION`, argued from the vendored source and
  stated as the remaining gap in the pull request. It needs Windows hardware.
- **A real Tauri window.** Compiling `apps/desktop/src-tauri` needs a Rust
  toolchain and the crates.io registry, and this environment reaches neither, so
  the native window itself could not be built. The bridge above stands in for it
  at the same boundary the real WebView provides.
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

Steps 2–3 are the part reproduced non-natively above. Step 4's continuation, and
the double-click in step 5, are covered by the unit suite at the DOM boundary.
