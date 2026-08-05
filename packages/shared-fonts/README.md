# Shared fonts

## Satoshi

Bundled as the **only** UI typeface for the native pill overlay.

- Source file: `satoshi/Satoshi-Medium.ttf`
- Embedded at compile time via `include_bytes!` into the Windows/macOS/GTK pill binaries.
- No system-font fallback: if loading the embedded face fails, the pill panics at startup (so packaging bugs are loud).

Satoshi is licensed under the [Indian Type Foundry Font License (FFL)](https://www.fontshare.com/licenses/ffl).
