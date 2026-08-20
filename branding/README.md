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
