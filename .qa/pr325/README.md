# PR 325 provider-mark visual evidence

Captured from the branch head with the vendored Chromium (`/tmp/chrome/out/chromium`,
153.0.8010.0) driving the **real preview app** at `http://127.0.0.1:5193` over the
Chrome DevTools Protocol, in both themes, at the app's own 1200px window width.
The preview mounts the actual `apps/desktop` components against the actual theme,
so these are renders of the branch and not of a mock.

`capture.mjs` in this directory is the script that produced them; `capture-manifest.json`
records the geometry. Both themes were captured by clicking the preview's own
scheme toggle, so each one exercises the same code path a user takes.

## Screens

| Surface                                  | Light                                                  | Dark                                                  |
| ---------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| Provider marks in the real surfaces      | [1200×2676](provider-marks-light-1200x2676.jpg)        | [1200×2676](provider-marks-dark-1200x2676.jpg)        |
| `PersonalApiKeyDialog` over the key list | [1200×800](personal-api-key-dialog-light-1200x800.jpg) | [1200×800](personal-api-key-dialog-dark-1200x800.jpg) |
| `ProviderLogo` matrix — every provider   | [1200×2676](provider-logo-matrix-light-1200x2676.jpg)  | [1200×2676](provider-logo-matrix-dark-1200x2676.jpg)  |

The first screen is the fixture at `#/provider-marks`, which mounts the four
components this branch touches where they actually ship: `ApiKeyList` in both
the post-processing and compact transcription layouts, `YourModelsCard` on the
overview card, `AudioTransmissionDisclosure` in both its variants, and the mark
sizes the surfaces use (14, 16, 18, 20, 22px). The third screen is the registry
demo, which is also the page the spec text renders under.

## What the frames show

- Every mark renders its own published artwork, in its own colours. No mark is
  tinted with the app palette, put on a chip, outlined or redrawn.
- **Gladia** swaps to its white markup on the onyx surface and **OpenRouter**
  swaps to its mono rendering, because its violet measures 2.87:1 there. Both
  are visible in the dark frames and are the only two per-scheme files.
- **Azure** now renders the Azure mark. It is one stored provider id with two
  products behind it — "Azure" for transcription and "Azure OpenAI" for
  post-processing — and both draw the same Azure artwork, because there is no
  separate Azure OpenAI mark to vendor.
- **Aldea**, **Speaches** and **OpenAI compatible** render nothing, which is the
  decision: no stand-in glyph, no initial. Three providers, not four; the prose
  that said four was corrected in this branch.

## Limits of this evidence

- This is a sample of rendered states, not a functional test of each one. The
  surfaces are the components, but the data behind them is the fixture's seeded
  keys, so the Ollama row shows the fixture's "unable to connect" error.
- The full `ui-capture` pipeline (`ffmpeg`, `ffprobe`, `gifsicle`, Playwright)
  is not installed in this image. Gap G9 covers it, and this directory uses the
  same fallback PR #288 used: a one-off Chromium, driven directly. There is no
  GIF for that reason and no contact sheet.
- No compact/narrow viewport is captured. These surfaces are a desktop settings
  page and a desktop dialog; the branch changes no responsive behaviour.
