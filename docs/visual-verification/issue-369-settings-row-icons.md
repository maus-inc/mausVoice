# Settings row icon language — visual verification

Issue #369 gives the desktop settings surface one icon language: every row leads
with a lucide glyph at `settingGlyphProps` (22px, stroke 1.9) in a fixed lane, and
the search field takes the same stroke at 16px through `settingSearchGlyphProps`.
This report records what the rendered surface showed in the browser preview and
what was measured from the DOM. It closes the visual pass #369 asked for.

## What was captured

The desktop browser preview (`pnpm --filter desktop dev:preview`) serves the
production route tree over a mocked Tauri runtime. Every settings page was opened
at `/dashboard/settings/<page>?scenario=populated&previewPopup=hidden`, in the
`light` and `dark` color schemes, at 1157×727 CSS pixels with reduced motion
emulated. The component catalogue (`apps/preview`) was opened at
`#/c/settings-row` in both schemes. The preview toolbar was hidden through the
preview's own `previewPopup` parameter, and the in-app provider tip was dismissed
with its own control before each capture so no popup covered a row.

Images live in `docs/assets/`:

| File | Surface |
| --- | --- |
| `settings-icons-dictation.light.png`, `.dark.png` | Dialog, control, value and switch rows on one page |
| `settings-icons-ai-models.light.png`, `.dark.png` | Provider-logo marks sharing the glyph lane |
| `settings-icons-account.light.png`, `.dark.png` | Identity row (avatar), danger rows |
| `settings-icons-catalogue.light.png`, `.dark.png` | The committed preview demo and its live spec |

## Measurements

Glyphs were found from the rendered DOM rather than by eye: every `svg` whose
measured box was 22px was recorded with its centre, stroke width, lucide class
and `aria-hidden` attribute. Results across all eight settings pages, in both
schemes (`home`, `dictation`, `ai-models`, `shortcuts`, `appearance`,
`privacy-data`, `system`, `account`):

- Every settings-lane glyph measures **22×22**. No other size appears in the lane.
- Every settings-lane glyph carries **stroke-width 1.9** (read from the `lucide-*`
  classes: `lucide-audio-lines`, `lucide-wand-sparkles`, `lucide-zap`,
  `lucide-bot`, `lucide-power`, `lucide-keyboard`, `lucide-circle-arrow-up`,
  `lucide-bell-ring`, and the rest).
- The lane centre is one value per page and identical across pages: **x = 536**
  at 1157px, and still x = 536 with the window narrowed to 900px.
- Every glyph is `aria-hidden="true"`, so no leading mark is part of a row name.
- **No horizontal overflow** on any page in either scheme, at 1157px or 900px.
- The search field's glyph measures **16×16, stroke 1.9, `lucide-search`,
  `aria-hidden="true"`**.

Two entries a naive sweep would flag are correct and belong to their documented
exceptions: the app sidebar's navigation glyphs (32px, stroke 1.85, centre x = 39)
are shell chrome, not settings rows; and the provider marks on `ai-models` are
`ProviderLogo` images, which carry no `stroke-width`, placed in the same 22px box
so the titles beside them land on the same edge as glyph rows.

## States checked

- **Hover**: the row takes `background-color` `rgba(0, 0, 0, 0.04)` on the level1
  face; the glyph colour does not shift, so the mark stays quiet while the row
  answers.
- **Focus-visible**: a 2px outline in `text.primary` (`rgb(26, 23, 18)` in light)
  at offset −2, on the row itself, not on the glyph. Reached by keyboard, the row
  is the focused element.
- **Danger**: `iconTone="danger"` rows on `account` take `error.main` on the glyph
  while the title keeps `text.primary`; checked in both schemes.
- **Avatar overhang**: on `account` the 48px avatar overhangs the 22px lane and the
  title still starts on the same edge as every other row on the page, which is the
  behaviour the fixed lane width was chosen for.

## What these captures are not

They are browser-preview captures driven by the mocked Tauri runtime, not
screenshots of a native Tauri window. GTK, AppKit and Win32 chrome, window
controls and native scrollbars are outside them. Fonts fall back to the system
stack where Satoshi is unavailable in the capture browser, so letterforms differ
slightly from a packaged build while the glyph lane, spacing and alignment do not
depend on them.

The one-off browser used `@sparticuz/chromium` with Puppeteer Core, run outside the
repository; no browser, automation package or test harness was added to it. The
sandbox has no Debian mirror access, so the two shared libraries that build needs
(`libnspr4`, `libnss3`) were compiled from NSS and NSPR sources fetched from GitHub
and linked from `/tmp` for the capture process only.
