# Guide figures are captured, not screenshotted by hand

Date: 2026-11-24
Status: superseded 2026-11-26, see the correction at the end

## Context

The 0.1.6 documentation overhaul needed annotated visuals for the pill, the
review panel, the Home heatmap, and the assistant. Hand-taken screenshots carry
the author's window size, theme, and app state, cannot be re-verified, and go
stale the moment a token changes.

`apps/docs` had no image pipeline. There is no Playwright harness in this repo
(`docs/decisions/no-playwright-harness.md`), and the agent sandbox has Chromium
but no Playwright package.

## Decision

Capture every figure from running code, and treat the PNGs as generated
artifacts. Two surfaces need two sources, because only one of them renders in a
webview.

- The React surfaces, which is the Home analytics grid and anything else drawn
  by the renderer, are captured from `apps/preview`. A demo mounts the real
  component with a deterministic fixture and marks its root with
  `data-capture="<id>"`. `apps/docs/scripts/capture-preview.mjs` opens that
  route in headless Chromium with `prefers-color-scheme: dark` forced and
  screenshots the marked element at 2x.
- The native surfaces, which is the pill and the review panel, are drawn by
  Cairo and GTK in `packages/rust_pill_shared` and its platform crates. They
  have no DOM, so no browser can capture them. Their figures are rendered by
  `apps/docs/scripts/figure-stage.html`, one `[data-figure="<id>"]` section
  each, from the same geometry, radii, colours and type values the Rust code
  draws with. `apps/docs/scripts/capture-guides.mjs` screenshots those sections
  the same way.
- `apps/docs/scripts/figures.mjs` lists the ids the preview script owns and the
  stage script skips them, so the two never write the same file. The shared
  launch, navigate, poll and screenshot code lives in
  `apps/docs/scripts/lib/capture.mjs`, and both scripts drive Chromium over the
  DevTools protocol with Node's built-in WebSocket.
- Every figure is one dark PNG at `public/guides/<id>.png`.
  `FigureImage.astro` renders a single image with no theme swap.
- Annotations are text in MDX (`Figure` and `Step` props), not baked into the
  image, so they stay selectable, searchable, and translatable.

Rejected: live CSS mocks rendered inside the MDX pages. They duplicated the
figure markup into the content, could not be embedded inside a step, and made
every page heavier than an image with a caption.

Rejected: a screenshot of the real pill. It needs the app running under Xvfb
with the vendored Rust toolchain and a GTK session, which the agent sandbox does
not have, so the recreation stays and the guides say so.

## Consequences

- A surface change is one command, `pnpm --filter docs figures`, plus a diff of
  the PNGs in the same PR. The command is one source because every figure now
  comes from the app.
- No figure is a drawing, so the guides never have to say which are which.
- Badges attach to their target through `.mv-anchor` and `data-n`, so a marker
  cannot drift away from the control it describes.
- The PNGs are committed, about 50 KB each, well under the repository's 5 MB
  file limit.
- The capture needs a debug build, tauri-driver and WebKitWebDriver. Those are
  operational tools, not product code, and the docs pages never import them.

## Correction, 2026-11-26: the stage is gone and every figure comes from the app

Two revisions landed on the same day, and this replaces both. The first one
described a single stage source, two theme files per figure (`<id>-light.png`
and `<id>-dark.png`) and a `data-theme` swap in `FigureImage.astro`, and it also
left the guides index claiming every figure was a screenshot of the shipped
interface, which was never true for a recreation.

The second revision went further and deleted the split. A recreation is not
evidence. A stage that redrew the pill from copied geometry could drift from the
pixels the Rust layer actually paints, and nothing in the pipeline noticed. A
figure taken from the running app cannot drift, and if a selector stops matching
the capture fails instead of shipping a stale drawing. The stage file,
`capture-guides.mjs`, `capture-preview.mjs` and the Chromium driver are gone.

What replaced it:

- `apps/docs/scripts/capture-app.mjs` launches the debug build, drives it with tauri-driver and WebKitWebDriver, and crops the region each figure names.
- `apps/docs/scripts/seed-guide-data.mjs` seeds transcriptions, dictionary terms, a chat thread, app targets, ten weeks of daily activity and the profile counters, so a figure shows a plausible history rather than zeros.
- `apps/docs/scripts/figures.mjs` keeps one entry per figure, with the route, the crop target, and the optional marker list.
- The guides annotate only what the captured surface can point at. Where the app has no stable hook for a badge, the figure carries a caption and the copy moves into the page.

Surfaces the app never paints in its webview, which is the pill and its review panel, no longer appear as figures at all. The guides describe them in prose and show the settings that control them, which is what a reader can open and check.
