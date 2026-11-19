# Shared fonts

## Satoshi

Bundled as the **only** UI typeface for the native pill overlay.

- Source file: `satoshi/Satoshi-Medium.ttf`
- Embedded at compile time via `include_bytes!` into the Windows/macOS/GTK pill binaries.
- No system-font fallback: if loading the embedded face fails, the pill panics at startup (so packaging bugs are loud).

Satoshi is licensed under the [Indian Type Foundry Font License (FFL)](https://www.fontshare.com/licenses/ffl).

## Geist Pixel

Bundled as the legend face for the 3D keycaps, on both the onboarding and the
dashboard views. Not a UI face: nothing else should use it.

- Source file: `geist-pixel/GeistPixel-Square.woff2` (the Square variant of the
  Geist Pixel family, `Geist Pixel Square` / `GeistPixel-Square` internally)
- Copied into `apps/desktop/src/assets/fonts/geist-pixel/` for the app build and
  declared as `@font-face { font-family: "Geist Pixel" }` in
  `apps/desktop/src/styles/fonts.css`
- Vendored from `geist@1.7.2` on npm, the Vercel release
- Licensed under the SIL Open Font License 1.1, text in
  `geist-pixel/OFL-1.1.txt`. The desktop bundle also includes this text in
  `apps/desktop/src-tauri/resources/geist-pixel-OFL-1.1.txt`.
