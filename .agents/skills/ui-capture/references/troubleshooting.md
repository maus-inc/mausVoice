# Troubleshooting

## The GIF is choppy

Capture faster than you encode. Set `captureFps` to 60 and `fps` to 30. When the
two are equal, the encoder has no frames to drop and any jitter in the capture
loop shows up as a stutter. Confirm the capture rate in the `capture.mjs` output
line; on a loaded host it can fall well below the target.

A `move` with a very short `ms` also reads as choppy, because the cursor crosses
the screen in two or three frames. Give moves at least 400ms.

## The GIF is too large to embed

GitHub renders an image inline up to 10MB. Past that it links instead of
showing, which defeats the purpose. Shrink in this order:

1. `--width 900` on `encode.mjs`.
2. `--max-seconds 12`, which drops frames evenly rather than truncating.
3. Lower `quality` in the storyboard to 80.
4. Shorten the storyboard. A ten second clip beats a twenty second one.

The encode prints a warning with the exact numbers when the result is too big.

## The cursor does not land on the control

The overlay cursor and the real pointer move together, but a `move` or `click`
still needs a selector that resolves to the control. Check the selector against
the element in `e2e/*.spec.ts`. If the control only appears after a previous
step, add a `wait` or an earlier step that opens it.

## The cursor and the hover state disagree

They should not. `capture.mjs` interpolates both pointers one step at a time, so
a hover state fires exactly when the cursor arrives. If you see a hover style
before the cursor reaches the element, the storyboard used a bare `page.mouse`
move outside this skill, or the app animates the element with a delay. Check the
app's own transition first.

## Fonts look wrong or text is clipped

The capture uses whatever fonts the container has. A missing system font falls
back and can change the layout. Run `npm run dev:browser` once by hand and look
at the page in the same container before capturing. If a font is missing, the
app has a real rendering defect in that environment, which is worth reporting.

## The sandbox has no browser

`capture.mjs` resolves Chromium the same way `playwright.config.ts` does. In
order: `PLAYWRIGHT_CHROMIUM_PATH`, the Playwright bundled browser, the
`@sparticuz/chromium` package, then a few well-known paths. When all fail, fetch
the vendored toolchain from the `vendor/sandbox-toolchain` branch, as
`AGENTS.md` under Blocked sandbox toolchain describes, and point
`PLAYWRIGHT_CHROMIUM_PATH` at its Chrome build. On a host without NSS and NSPR,
set `PLAYWRIGHT_SANDBOX_LIBS` to the directory that carries `libnss3` and
`libnspr4`, or the browser exits before the first frame.

## `ffmpeg` or `gifsicle` is missing

```bash
sudo apt-get install -y ffmpeg gifsicle
```

Without `ffmpeg` the pipeline stops. Without `gifsicle` the GIF is written
unoptimized and larger, and the encode prints a note saying so. Install both.

## The clip is a still image

The validator's `motion` check fails when fewer than a tenth of the frames
change. The usual causes are a storyboard that only waits, a route that never
rendered, or a click that missed and left the page unchanged. Open
`review/inspect-sheet.png` and compare the numbered frames.

## The `captions` check fails

The `captions` check reads the bottom band of every frame and fails when almost
none of them carry near-white caption text. A storyboard with no `subtitle` step
is the common cause: add one per step. When subtitles are present but the check
still fails, the overlay did not mount; see Nothing renders in the shadow overlay.

## The `caption-text` check fails

With `tesseract` installed, the validator reads each caption back and compares it
to the storyboard text. A failure means the pixels do not say what the storyboard
claims, which is exactly the defect the skill exists to catch. Read the `want` and
`read` lines it prints. Common causes: the caption faded in after the sampled
frame (the check samples mid-segment to avoid this, but a very short segment can
still catch the fade), OCR misreading a stylized glyph, or a genuine wrong-screen
capture. Look at `review/subtitle-strip.png` to tell them apart. The check is
skipped, with a note, when `tesseract` is absent.

## Validate passes but the clip is wrong

The mechanical checks prove the clip moves, is smooth, carries captions, and, with
OCR, says the right words. They cannot prove the pixels show the right screen. This
is why step 5 is a vision read. If the frames show the wrong screen, a caption over
the wrong step, or a state that never changed, the capture failed regardless of
what the checks say. Fix the storyboard or the code and re-run.

## Nothing renders in the shadow overlay

The overlay attaches to `document.documentElement`, which is null while
`addInitScript` runs before the parser. The script mounts on `DOMContentLoaded`
in that case. If you edit `overlay.js` and the overlay disappears, check that
`window.__uicap` is defined in the page and that the host element with id
`__uicap-root` is in the DOM.
