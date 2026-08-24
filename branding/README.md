# mausVoice branding

- `usethislogo-source.png`: full-resolution source artwork
- `mausvoice-logo-1024.png`: cropped/squared 1024x1024 master used to generate all app icons
- `mausvoice-logo-256.png`: 256x256 preview

## Regenerating icons

Resize `mausvoice-logo-1024.png` into each icon set:

- Desktop app: `apps/desktop/src-tauri/icons/`
- Windows installer: `apps/windows-installer/src-tauri/icons/`

The desktop app references `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, and `icon.ico`; the Windows installer references `32x32.png`, `128x128.png`, and `icon.ico`.

Example using ImageMagick to generate the shared PNG sizes:

```bash
# Desktop app
convert branding/mausvoice-logo-1024.png -resize 32x32 apps/desktop/src-tauri/icons/32x32.png
convert branding/mausvoice-logo-1024.png -resize 128x128 apps/desktop/src-tauri/icons/128x128.png
convert branding/mausvoice-logo-1024.png -resize 256x256 apps/desktop/src-tauri/icons/128x128@2x.png

# Windows installer
convert branding/mausvoice-logo-1024.png -resize 32x32 apps/windows-installer/src-tauri/icons/32x32.png
convert branding/mausvoice-logo-1024.png -resize 128x128 apps/windows-installer/src-tauri/icons/128x128.png
```

Generate the multi-resolution `icon.ico` (desktop and installer) and `icon.icns` (desktop only) from the 1024x1024 source using your preferred tool (e.g. ImageMagick for `.ico`, `iconutil` for `.icns`).

## Windows installer sidebar

`branding/mausvoice-sidebar-installerimg.png` is the custom art shown
on the Welcome and Finish pages of the Windows NSIS setup, replacing the stock
blue NSIS panel.

- Format: PNG (8-bit, non-interlaced) or BMP (24/32-bit uncompressed).
- Full-bleed 164x314 art renders edge to edge; other aspect ratios are
  contain-fit and letterboxed with a background sampled from the art's edges
  (white when the art has no opaque edge, e.g. a bare logo).

The NSIS wizard only accepts a 24-bit BMP, so the bitmap is regenerated from
the root art on every build:

```bash
node scripts/generate-windows-installer-sidebar.mjs
```

The output (`apps/desktop/src-tauri/icons/nsis-sidebar.bmp`) is generated and
gitignored; the desktop `build` script regenerates it (with `--windows-only`,
so mac/Linux builds - which never bundle NSIS - are not gated on the art) and
the Windows CI jobs regenerate it, so it can never drift from the committed
art.
