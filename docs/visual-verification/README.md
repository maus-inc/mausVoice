# Visual verification: capture, inspect, attach

Every surface this repository draws is judged by a person. Screenshots are how the
person judges code they did not run, so the capture is part of the delivery, not an
extra. This page is the procedure. It is mandatory wherever it applies, and `AGENTS.md`
loads it by name for that reason.

Read this end to end before the first capture. Follow it again after every change to the
UI, because the image that is attached has to be the image of the code you are asking
someone to merge.

## When it applies

Any change whose diff alters what a person sees or how it reads, in any file and any
language: a React component, a CSS token, a Rust pill glyph, an Astro page, `index.html`,
an icon or SVG, a copy string, a dialog, a native window surface. It also applies to a
change that only *looks* like it cannot matter. A two-value spacing tweak moves a
baseline, and a moved baseline is exactly what a reviewer cannot see in a diff.

It does not apply to work with no rendered surface: CI scripts, Rust transcription
plumbing, package metadata. Say so in the pull request instead of staying silent, and
name the reason.

`engineering/design-skills.md` decides the mode for anything captured or attached.
`docs/visual-verification/**` and every screenshot attached to a pull request are
Illustrated, which is stricter than the product mode the component itself ships under.
The Stageshow report is separate from this procedure and still required: name the mode,
the rule ids and the frames looked at.

## 1. Start the app on the mocked backend

The mocked backend is the desktop preview. It renders the real components from
`apps/desktop/src` against a fake Tauri layer, so nothing needs a native window, a
microphone or a keychain.

```bash
pnpm install
pnpm --filter desktop dev:preview        # the app, on port 1420
pnpm --filter @maus-inc/preview dev      # the component catalogue, on port 5193
```

`PREVIEW_ALLOWED_HOSTS` applies to the catalogue on port 5193 only
(`apps/preview/vite.config.ts`): set it to the host you browse from, or the server refuses
the origin and you get a blank page that looks like a code fault. The desktop server reads
no such variable; it allows `*` when the request is to `localhost` and `.e2b.app` when the
browser preview is on, which covers this repository's preview host. A capture driven from
any other host has to go through the catalogue, or the desktop server needs a config change
first, which is a separate decision.

The preview mints its own fixture state. Two query parameters matter when capturing:

- `?previewPopup=hidden` keeps the preview-only toolbar out of the frame.
- The scenario picker seeds deterministic data. Pick the scenario the change affects
  rather than the default one, and say which you used.

If a surface needs state the fixtures do not carry (a saved provider key, a recorded
transcription), that is a finding: name it in the report and verify what you can from
the rules and the tests, rather than describing a screenshot you could not take.

## 2. Drive it with a throwaway browser

Nothing installed for a capture goes into the repository. A browser, an automation
package and a capture script all live outside the working tree, as
`docs/visual-verification/pr-293-home-metric-grid.md` records. The repository has no
browser dependency and must not gain one for a screenshot.

Prefer the scripts that already implement this. `scripts/verify/` holds a pinned capture
harness — `install-chromium.mjs` fetches the browser outside the tree, `shot-settings.mjs`
walks the eight settings pages at three widths and writes geometry to
`settings-layout.json`, and `click-settings.mjs` walks the rail, search and keyboard flow
in both themes. `engineering/ui-verification/README.md` is their reference page: URL
variables, the before/after `montage` convention under `reports/ui-verify/`, and the
fonts-and-tokens checks that decide whether a capture is valid at all. Use them when the
surface they cover is the surface you changed, and treat their geometry JSON as the
measurement in section 3. The `/tmp` route below still applies to a surface they do not
cover, such as a dashboard route reached only through the mocked desktop app.

The documented pattern, from that record: a `/tmp` directory outside the repository,
`puppeteer-core` plus one Chromium payload, and a script that walks the routes.

The repository provides two throwaway Chromium paths on restricted Linux x86-64 hosts, neither requiring browser download CDNs:

- **Lightweight screenshot path (when npm is reachable).** `node scripts/verify/install-chromium.mjs --dir /tmp/chr` unpacks `@sparticuz/chromium` and its shared libraries into `/tmp/chr` without downloading the full vendor archive.
- **Full vendored path (offline or when recording video/GIFs).** `vendor/sandbox-toolchain` carries headless Chromium at `system/tools/bin/chromium` along with `ffmpeg`, `ffprobe`, `gifsicle`, `tesseract`, and the WebDriver driver chain. Follow `engineering/sandbox-vendored-toolchain.md` and `FETCH.md` on the branch to extract and reassemble it in `/tmp`.

```bash
node scripts/verify/install-chromium.mjs --dir /tmp/chr
# prints CHROMIUM_PATH and LD_LIBRARY_PATH; the verify scripts read /tmp/chr directly
```

The manually staged `/tmp` route below is the fallback for a host where that fails:

```bash
mkdir -p /tmp/shot /tmp/shots && cd /tmp/shot
npm init -y
npm install puppeteer-core @sparticuz/chromium
```

```js
// /tmp/shot/capture.mjs — outside the repository, never committed
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

const routes = [
  ["settings-home", "/dashboard/settings"],
  ["settings-account", "/dashboard/settings/account"],
];

const browser = await puppeteer.launch({
  args: chromium.args,
  executablePath: await chromium.executablePath(),
  headless: true,
  defaultViewport: { width: 1157, height: 727, deviceScaleFactor: 2 },
});

for (const scheme of ["dark", "light"]) {
  for (const [name, path] of routes) {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: scheme },
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    await page.evaluateOnNewDocument((mode) => {
      try {
        localStorage.setItem("mui-mode", mode);
      } catch {}
    }, scheme);
    await page.goto(`http://localhost:1420${path}?previewPopup=hidden`, {
      waitUntil: "networkidle0",
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Tip cards render only on their own route, so a route added to this list that
    // matches a tip's href captures the tip over the rows under review. The selector
    // is the card's own data attribute, not its button's label: the label is
    // translated, so a label selector stops matching the moment the app is in Spanish
    // or any other locale and the loop silently dismisses nothing.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const dismiss = await page.$('[data-tip-card="true"] button[aria-label]');
      if (!dismiss) break;
      await dismiss.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    const covered = await page.$('[data-tip-card="true"] button[aria-label]');
    if (covered) throw new Error(`a tip still covers ${name} in ${scheme}`);

    await page.screenshot({ path: `/tmp/shots/${name}.${scheme}.png` });
    await page.close();
  }
}

await browser.close();
```

Three rules for the capture itself:

- **Reduce motion first.** Confetti, a slide-in and a spinner all produce a different
  frame each run, and a pair that differs for that reason proves nothing.
- **Dismiss what covers the surface.** Tip cards and one-time announcements sit over
  exactly the rows a reviewer needs to see, and they render per route, so a route that
  looks clean on one revision can carry one after a copy change. Dismiss every tip, wait, and
  assert none remains before the shutter, as the loop above does. A capture that throws
  that error is a real finding, not a flake: the surface under review was covered.
- **One viewport per claim.** Capture at the size the claim is about. A 1157×727 window
  says nothing about a 900px one, so capture both when the layout reflows.

When a capture cannot run, say so plainly and name the gap from
`engineering/sandbox-coverage-gaps.md`. Never attach a recording you did not watch, and
never describe a capture you did not make.

### Get both sides of a pair from two real trees

A before/after pair is worth only as much as the "before" is real. A frame produced by
switching old CSS off in one browser is a claim about what the old code would have drawn,
not what it drew. Build the base instead:

```bash
git worktree add /tmp/base-wt <base-sha>
cd /tmp/base-wt && ln -s <this-repo>/node_modules node_modules
for d in apps/preview apps/desktop packages/types packages/desktop-native-apis; do
  ln -s <this-repo>/$d/node_modules $d/node_modules
done
# Serve the base's own catalogue on a second port, with the base's own vite.
```

Then capture the same harness URL, scenario, viewport and device scale factor from both
ports. `scripts/verify/shot-settings.mjs` already takes `HARNESS_URL`; the pair is the
same script pointed at 5293 and 5193. A demo this branch added does not exist in the base,
so pair the real pages instead of a demo — the pages are what ships.

Two traps that cost a whole pass:

- **`fullPage: true` on a page whose body is a fixed-height shell writes a blank PNG.**
  The frames come out uniformly dark, which reads like "the base drew nothing" rather than
  like a capture bug. Capture the viewport and scroll to the top, and check the file size
  or open one frame before trusting a batch.
- **A DOM probe that looks for `[aria-hidden="true"]` inside a row also matches the
  trailing chevron.** It reports a leading mark on a row that has none, and the count looks
  clean while the pixels are wrong. Scope the probe to the leading slot, and let the crop
  decide.

## 3. Inspect the pixels, and let them drive the code

This is the step that is skipped and the reason this page exists.

Looking at the image is not confirming the measurement. Read the frame for what it
looks like: a gutter that reads as a gutter, a title that reads as aligned, a glyph that
reads as its own size, a control that reads as belonging to its row. The runtime is what
the person sees. If the pixels disagree with what the code was meant to express, the
pixels win and the code changes.

- Look at everything the change touches, plus the region around it. A fix that shifts a
  baseline breaks the row above it.
- Look at the upper-left of each surface, where the leading glyph, the title edge and
  the first rule meet. That corner carries most of the spatial errors.
- Follow the back-and-forth loop: open a dialog behind a row, come back, and check the
  row still reads correctly after the return.
- Measure *as well as* look. A DOM reading explains a look you do not like and stops you
  guessing: `getBoundingClientRect` on the lane, the title and the row turns "this looks
  cramped" into "3px of air on both sides". Quote the numbers in the report.
- Prefer crop-and-magnify to squinting at a full frame. A 3× or 4× crop of a single row
  shows whether a stroke is even and whether a gutter is real.
- Compare against a reference when one exists: the design doc, the previous release, a
  comparable shipped product. Say what you compared.

A rendered surface that looks wrong is a defect, whatever the tests say, and a test that
pitches the wrong behaviour has to change with it. Do not tune a screenshot, and do not
argue a look down: fix the code, or bring the choice to the human with both options
captured.

## 4. Attach it to the pull request, in the description

The description is where a reviewer starts. Evidence kept in the diff, a comment far
below, or a checklist link makes them dig, and evidence that has to be dug for is
evidence that is not read.

- **Embed the images in the pull request description itself**, as markdown images, in a
  section the reader meets before any fold. Do not bury the frames in a `<details>`
  block, a review comment or a link to a run artifact. `scripts/ci/check-visual-evidence.mjs`
  fails the pull request when the description carries no image.
- **Pin in one commit, delete in the next commit.** PR-only verification screenshots
  do not need to land in the base branch. Stage and commit the captured images on the
  PR branch in a pin commit, for example under `docs/assets/`. Push that commit, note
  its full SHA as `<pin-sha>`, and embed
  `https://github.com/maus-inc/mausVoice/raw/<pin-sha>/...` above the folds in the PR
  description. Delete those screenshot files with `git rm` in the very next commit.
  GitHub continues serving the pinned images from `<pin-sha>` in branch history, and
  the final PR diff stays free of image bloat. Never use `raw/HEAD/...`, because `HEAD`
  resolves to the default branch and returns 404 on a feature branch. Verify each URL
  after pushing with `curl -s -o /dev/null -w '%{http_code}' <url>`, expecting `302` or
  `200` rather than `404`. Do not rebase or squash `<pin-sha>` away while the PR is
  open.
- **Update whenever UI changes occur.** An image from an earlier commit misrepresents
  the head. After any edit that changes a rendered surface, re-capture the affected
  frames, commit them in a new pin commit as `<new-pin-sha>`, delete them in the next
  commit, and update the PR description URLs in place to `<new-pin-sha>`.
- **Attach, do not link a local path.** Use a GitHub attachment URL or the pin and
  delete commit URL flow above. Keep permanent files under `docs/assets/` only for
  assets referenced by shipped documentation or `README.md`, not for PR-only
  before/after evidence.
- **Dark mode is what you attach; light mode is what you inspect.** Keep the description
  to the dark frames so it does not bloat. Capture light for every surface you touched
  and look at it with the same care, then state in the description that the light pass
  ran and what it showed. Attach a light frame only when the change is about light: a
  light-mode contrast fix, a shadow, a token that only resolves once in each scheme.
- **Before and after, named.** A single frame of the new state does not show a change.
  Pair the base commit's frame with the head commit's frame for each touched surface,
  labelled with the commit so the pair can be reproduced.
- **State which surfaces were not captured**, and why, in the same section. A missing
  frame that is admitted is honest; a missing frame that is implied is a wrong claim.

Update the description in place. Do not append a new section per round:
`scripts/ci/check-pr-body.mjs` keeps the unfolded body to one screen, records fold, and
will reject a body that grows a heading per round.

## 5. Fold and shape constraints

The body checker runs on every edit, so write to its shape from the start:

```bash
node scripts/ci/check-pr-body.mjs <body.md>          # before you push the body
node scripts/ci/check-visual-evidence.mjs <body.md> --base <base-sha>  # the image requirement
```

`--base` is not optional in practice. Without it the checker reads only the staged index,
so a committed UI change that is no longer staged names no UI path and the image
requirement never runs; the failure then appears only after the push. Pass the base commit
or branch the pull request targets.

Put the visual section under `## Summary` with the pinned frames unfolded as markdown
images. `check-visual-evidence.mjs` fails if any image sits inside a `<details>` fold.
Keep the light-mode statement and uncaptured list as short bullets. Put long tables of
per-row readings, bounding-box deltas, and detailed verification notes inside a folded
`<details><summary>Visual verification</summary>` block in the PR description instead of
committing a new Markdown file under `docs/visual-verification/`.

After deleting the temporary screenshots in the next commit, run `standards-review.mjs`
on the clean post-deletion HEAD. Every path cited in `CS01` through `CS08` must exist in
the final `base...head` diff, so do not cite deleted screenshot paths.

## 6. Record what you saw

Record the visual verification details in the pull request description inside a folded
`<details><summary>Visual verification</summary>` block. Do not commit a new per-PR file
under `docs/visual-verification/`, because PR verification records do not need to land in
the base branch. Include the capture method, the base and head SHAs, the pinned screenshot
commit SHA, the measurements behind each claim, what looked wrong and what changed
because of it, and the manual steps a reviewer can follow. Add a permanent Markdown
record under `docs/visual-verification/` only when a human asks to keep one in the
repository.

Name every frame you attached and every frame you looked at but did not attach. The
distinction is the honest part.

## Checklist

- [ ] Change alters something a person sees, or I said why not.
- [ ] `dev:preview` running; scenario and route named.
- [ ] Browser and scripts outside the repository; nothing added to the tree.
- [ ] Dark and light captured at the claim's viewport; motion reduced; overlays dismissed.
- [ ] Every frame inspected, including the upper-left region and the dialog round trip.
- [ ] What looked wrong changed the code, or came to the human with both options.
- [ ] Before/after dark frames pinned in a commit, embedded above the folds in the PR description via `raw/<pin-sha>/...`, and deleted in the next commit. Repeated after every subsequent UI edit.
- [ ] Light pass stated in the description; any light frame attached only where it is the subject.
- [ ] Uncaptured surfaces and the reason listed.
- [ ] Detailed measurements and visual verification notes recorded in a folded `<details>` block in the PR description, with no per-PR verification doc or temporary PNGs left in the final tree.
- [ ] `check-pr-body.mjs`, `check-visual-evidence.mjs --base <sha>`, and `standards-review.mjs` pass on the clean post-deletion HEAD.
