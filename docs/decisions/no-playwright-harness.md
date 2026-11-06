# No Playwright harness, and apps/preview is the visual verification surface

Date: 2026-10-29
Status: accepted

## Context

The `ui-capture` skill asks for a UI change to be recorded as a smooth GIF and watched
before filing a pull request. That needs browser automation.

This repository has no Playwright. Nothing in any `package.json` names `playwright`,
`puppeteer` or `cypress`. `@vitest/browser` is absent, so the preview tests run under
`jsdom` rather than a real browser. `engineering/sandbox-vendored-toolchain.md` records
the matching decision not to vendor a browser group into the sandbox toolchain.

Correction, 2026-11-05. This decision used to claim that nothing names `webdriverio`
either. That was wrong. `apps/desktop/package.json` carries `@wdio/cli`, `@wdio/globals`,
`@wdio/local-runner`, `@wdio/mocha-framework`, `@wdio/spec-reporter` and
`chromedriver`, with `webdriverio` arriving transitively through them,
`apps/desktop/webdriver/` holds `wdio.conf.js` and one spec, and
`pnpm --filter desktop test:webdriver` runs it. On Linux that suite spawns `tauri-driver`
and WebKitWebDriver against a built Tauri binary. On macOS it spawns `chromedriver`
against a Vite preview server. No workflow invokes it.

What does exist, and was overlooked when this decision was first drafted, is
`apps/preview`. It is a Vite and React app served on port 5193 by
`pnpm --filter @maus-inc/preview dev`, it renders the real components from
`apps/desktop/src` rather than copies, it has demo pages per component group, a spec
viewer, light and dark simulated surfaces, and 22 passing tests.

## Decision

Do not add a browser automation stack for this change. Treat `apps/preview` as the
substitute verification surface:

- Run the dev server and inspect the demo group covering the changed surface, in light
  and in dark.
- Report what was inspected and what it confirmed, so a reviewer can distinguish an
  inspected change from an uninspected one.
- State plainly that no recording was made, rather than marking the gate passed.

Rejected: adding Playwright and vendoring its roughly 933 MB download into the offline
sandbox. The cost is out of proportion to the benefit while a rendering surface already
exists in the repository. Also rejected: vendoring a Chrome for Testing build and
`tauri-driver` so the existing WebDriver suite can run here. That is gap G11 in
`engineering/sandbox-coverage-gaps.md`, and it stays closed until a task needs it. The
media tools that `ui-capture` needs, `ffmpeg` and `gifsicle`, are a separate gap, G9, and
they are cheap enough to build.

## Consequences

This makes it easy to check a real rendered surface with no extra infrastructure, and it
keeps the offline sandbox small. It makes it hard to catch visual regressions
automatically, because nothing compares renders over time. A reviewer must rely on a
written report of a manual inspection.

`apps/preview` is also a generated surface: `apps/preview/scripts/write-specs.mjs`
produces the 39 files in `apps/preview/specs/`, and `gen:specs` overwrites them. Nothing
in CI runs that generator, so the specs can drift from the code without anything
failing. One such drift is recorded in `engineering/design-skills.md`, where
`specs/color.md` still describes a blue accent that `apps/desktop/DESIGN.md` removed.
