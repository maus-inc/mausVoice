---
title: "Install on Linux"
description: "Install the Debian or AppImage package and prepare X11 or Wayland input support."
sidebar:
  order: 5
---

Linux releases include a Debian package and an AppImage. Check the latest [GitHub release](https://github.com/maus-inc/mausVoice/releases) for the filenames actually published for that version.

## Debian package

```bash
sudo dpkg -i ./mausVoice_*.deb
sudo apt-get install -f
```

The second command resolves missing package dependencies if `dpkg` reports them. Upgrade by installing the newer package over the existing one.

## AppImage

```bash
chmod +x ./mausVoice_*.AppImage
./mausVoice_*.AppImage
```

An AppImage is portable, but microphone, global shortcut, and simulated-input permissions still come from the desktop session. Moving the file later may invalidate a launcher entry you created for its old path.

## X11 and Wayland

Identify the active session:

```bash
echo "$XDG_SESSION_TYPE"
```

On **X11**, mausVoice can use `xdotool` for simulated input. Install it with your distribution's package manager if insertion fails.

On **Wayland**, compositor security prevents applications from using X11-style global input APIs. mausVoice supports compositor-specific shortcut registration and can use `ydotool` for kernel-level input simulation; Sway and Hyprland can also use `wtype` as a fallback. `ydotool` needs access to `/dev/uinput`, commonly supplied by an `input` group membership and a udev rule. Log out and back in after changing group membership.

The GTK pill uses layer-shell on compositors that support it. On unsupported compositors, most notably GNOME/Mutter, the native pill helper attempts to relaunch through its X11 backend when an Xwayland display is available. If the fallback is unavailable or the pill is still absent, recording can still work; treat pill visibility and audio capture as separate checks.

## Troubleshooting

### Blank window on X11 or with i3

If mausVoice opens a blank window on X11 (common with i3, bspwm, and some NVIDIA + tiling setups), the WebKitGTK compositing path is failing. mausVoice sets `WEBKIT_DISABLE_COMPOSITING_MODE=1` and `WEBKIT_DISABLE_DMABUF_RENDERER=1` automatically when `XDG_SESSION_TYPE=x11` is set at launch, so make sure that variable is exported by your display manager or session script before the app starts. You can confirm it with `echo "$XDG_SESSION_TYPE"` in the same shell you launch mausVoice from.

If the window is still blank after that, run from a terminal to capture the WebKit log and look for `EGL_BAD_PARAMETER`:

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 mausVoice
```

Forcing the values explicitly also lets you turn the workaround off on systems where it makes things worse.

### Super key not detected as a hotkey

WebKitGTK reports the Super key as `OSLeft` / `OSRight` (or `SuperL` / `WinL` on some distributions). mausVoice treats all of `Meta*`, `OS*`, `Super*`, and `Win*` as the Super modifier when recording a Wayland compositor binding, so a Super-based shortcut should register the same as on macOS or Windows. If the hotkey picker does not pick up the Super key at all, the underlying global-shortcut port (e.g. `gnome-shell`, `kglobalacceld`, the Sway IPC) is likely the blocker rather than mausVoice.
