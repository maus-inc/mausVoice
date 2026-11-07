---
name: ui-capture
description: This skill should be used when the user asks to "record a GIF of the UI", "capture a UI change", "make a demo GIF", "record a smooth 30fps GIF to validate UI work", "show the mouse in a recording", "add subtitles to a UI recording", "record mouse actions", or when an agent must prove a UI change works by watching it rather than reading the diff. Records the running app through the repo's Playwright browser, draws a simulated mouse and a bottom subtitle bar, encodes a smooth 30fps GIF, and builds the images an agent must look at before reporting.
---

# UI capture and review

Record the running app into a smooth GIF that shows what the pointer did, then
watch the recording and confirm it makes sense. The GIF is the evidence that a
UI change works, and the review of it is the work.

This skill is for a change that a user sees and interacts with. It is not for
reading code, running unit tests, or judging design taste. Those have their own
skills. Use it when the honest answer to "does this work" is "watch it".

## What it produces

For each captured flow, under an output directory:

- `out.gif` a smooth GIF at 30fps, sized to embed in a pull request
- `out.mp4` the same clip as a video, for a reviewer who wants a scrub bar
- `frames/` every captured frame, the raw evidence
- `screenshots/` one still per named state, for static evidence
- `contact-sheet.png` the whole timeline in one image
- `review/inspect-sheet.png` twelve numbered frames for one vision read
- `review/subtitle-strip.png` the bottom caption band from every frame, stacked
- `timeline.json`, `encode-report.json`, `review/validate-report.json` machine checks

## Toolchain

The scripts need `ffmpeg`, `ffprobe`, and `gifsicle`, plus a Chromium that the
repo's Playwright can launch. Install the media tools when they are missing:

```bash
sudo apt-get install -y ffmpeg gifsicle      # Debian/Ubuntu
brew install ffmpeg gifsicle                 # macOS
```

`tesseract-ocr` is optional. When it is installed, `validate.mjs` reads each
caption back with OCR and compares it to the storyboard, which is the strongest
automated proof that the clip shows what it claims. Install it with
`sudo apt-get install -y tesseract-ocr` or `brew install tesseract`. Without it,
that one check is skipped and the report says so; the vision read still applies.

Chromium resolves through the same order as `playwright.config.ts`, so a
sandbox that already runs `npm run qa` needs no extra setup. When it does not,
`PLAYWRIGHT_CHROMIUM_PATH` points at an explicit binary, and the vendored
toolchain branch in `AGENTS.md` carries one for a blocked sandbox.

## Workflow

Run the five steps in order. Steps 3 and 4 are mechanical. Steps 1, 2 and 5 are
where the judgement is.

### 1. Prepare the app

Capture the branch's live work, not a mock of it. Start the app the way the repo
does and leave it running:

```bash
npm run dev:browser          # the full UI with the mocked Tauri backend, port 48921
```

Use `npm run qa` or the Playwright suite in `e2e/` to confirm the flow works
headlessly first. A capture of a broken flow wastes an encode and teaches
nothing. Reuse the repo's selectors and seed modes from `e2e/fixtures.ts`; do
not invent a parallel test harness.

### 2. Write the storyboard

A storyboard is JSON that lists the steps of one flow. Copy
`examples/example-storyboard.json` and edit it. Each step is one action, run in
order, while the capture loop records frames underneath.

```json
{
  "name": "settings-editor-switch",
  "url": "http://127.0.0.1:48921/settings",
  "viewport": { "width": 1280, "height": 800 },
  "steps": [
    { "action": "badge", "text": "settings-editor-switch" },
    { "action": "subtitle", "text": "Settings opens on Providers" },
    { "action": "wait", "ms": 700 },
    { "action": "screenshot", "label": "settings-providers" },
    { "action": "subtitle", "text": "Select the Editor section" },
    { "action": "move", "selector": "#bettershape-settings nav >> button:has-text(\"Editor\")", "ms": 600 },
    { "action": "click", "selector": "#bettershape-settings nav >> button:has-text(\"Editor\")" },
    { "action": "wait", "ms": 700 },
    { "action": "screenshot", "label": "settings-editor" },
    { "action": "subtitle", "text": "Toggle the first switch" },
    { "action": "click", "selector": "[role=\"switch\"]" },
    { "action": "wait", "ms": 900 },
    { "action": "screenshot", "label": "switch-toggled" }
  ]
}
```

The action set is in `references/storyboard.md`. The ones that matter most:
`move` glides the cursor to a target, `click` presses and releases with a
ripple, `hover`, `drag`, `dblclick`, `type` and `scroll` cover the rest of the
mouse and keyboard. `subtitle` sets the caption. `screenshot` saves a labelled
still. `wait` holds a state long enough to read.

Point `selector` at a real control using the repo's role and text locators. A
capture where the cursor lands beside the button is a failed capture, not a
rendering quirk.

Write one storyboard per flow, and keep each under about fifteen seconds. A
reviewer watches a short clip. Split a long flow into two clips.

### 3. Capture

```bash
node .agents/skills/ui-capture/scripts/capture.mjs storyboard.json --out .qa-artifacts/capture
```

This launches Chromium, installs the overlay before the first paint, runs the
storyboard, and writes viewport frames at up to 60fps. Capture at 60 and encode
at 30: the extra frames are what make the encode smooth rather than stuttery.

### 4. Encode

```bash
node .agents/skills/ui-capture/scripts/encode.mjs .qa-artifacts/capture --width 1100
```

Two-pass palette generation, then `gifsicle -O3`. The encode reads
`timeline.json` for the measured capture rate, so the GIF plays at wall-clock
speed. Keep the GIF under 10MB; GitHub renders that inline. If the report warns
the file is larger, re-run with `--width 900 --max-seconds 12`.

### 5. Watch it, then report

This is the step that makes the skill worth running. Run the validator, then
open the images it writes and read them.

```bash
node .agents/skills/ui-capture/scripts/validate.mjs .qa-artifacts/capture
```

The validator writes `review/inspect-sheet.png` and `review/subtitle-strip.png`
and a `validate-report.json` with mechanical checks: the clip moves, the moving
frames are at 30fps, the length is sane, the caption band is present, and, with
`tesseract` installed, the caption text reads back as the storyboard text. Those
checks prove the clip moves, is smooth, and says the right words. They cannot
prove the pixels show the right screen. That part is a vision read, and it is
required.

Open both images and answer every question:

- Does each frame match the step it claims? The subtitle names the step, so a
  caption over the wrong screen is a finding.
- Does the cursor land on the intended control, and is the click ripple on it?
- Do the captions read as correct, legible English, and in the right order?
- Does the changed state actually appear? The before and after must differ in
  the way the change promises.
- Is anything clipped, overlapping, or scrolled out of view at this viewport?

Write the answers into the report. A capture that passes the mechanical checks
but shows the wrong thing is a failed capture. Fix the storyboard or the code
and re-run. Never attach a GIF you have not looked at.

## Rules

- Capture the live branch, never a mock of it. The point is to see the real app.
- One flow per clip, under fifteen seconds.
- Every clip carries a subtitle that names the step, so the clip explains itself
  without the diff.
- The mouse must be visible and must land on the controls it acts on. A cursor
  that misses is a wrong capture.
- Watch the output. The mechanical checks are necessary and not sufficient.
- Do not edit the overlay to hide a real defect. If the UI is wrong, that is the
  finding.
- Keep the artifacts out of git. Write under `.qa-artifacts/`, which is ignored.

## When a capture cannot run

Say so and say why, in the report. A blocked browser, a missing `ffmpeg`, or a
route behind auth that the mock does not serve are all reportable outcomes.
Describe what you tried and what could not be shown. An honest gap beats a
fabricated GIF.

## Additional resources

- `references/storyboard.md` the full storyboard schema, every action, and the
  field each one takes.
- `references/troubleshooting.md` choppy output, oversized GIFs, cursor
  desync, missing fonts, and the sandbox browser.
- `scripts/overlay.js` the mouse, ripple and subtitle overlay, installed as an
  init script.
- `scripts/capture.mjs`, `scripts/encode.mjs`, `scripts/validate.mjs` the three
  pipeline stages.
- `examples/example-storyboard.json` a working storyboard for this repo.
