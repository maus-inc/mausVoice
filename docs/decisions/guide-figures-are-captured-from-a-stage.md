# Guide figures are captured, not screenshotted by hand

Date: 2026-11-24
Status: accepted, corrected 2026-11-26

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

- A surface change is one command per source, `pnpm --filter docs figures` and
  `pnpm --filter docs figures:preview`, plus a diff of the PNGs in the same PR.
- The guides state which figures are captures and which are recreations, so a
  reader is never told a drawing is a screenshot.
- Badges attach to their target through `.mv-anchor` and `data-n`, so a marker
  cannot drift away from the control it describes.
- The PNGs are committed, about 50 KB each, well under the repository's 5 MB
  file limit.
- The stage file is HTML rather than Astro components. It is illustration
  markup, not product code, and it must be kept in step with the shipped
  surface by review. The docs pages never import it.

## Correction, 2026-11-26

The first revision of this record described a single stage source, two theme
files per figure (`<id>-light.png` and `<id>-dark.png`), and a `data-theme`
swap in `FigureImage.astro`. All three were wrong once the Home figure moved to
a real capture and the set went dark-only, and the guides index also claimed
every figure was a screenshot of the shipped interface, which was never true for
the Rust-drawn pill. The record and the guides now state the split.
