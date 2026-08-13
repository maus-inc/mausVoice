---
title: Linux
description: Install and configure mausVoice on Linux.
---

## Installation

There are multiple Linux installation options available on the [download page](https://maus-inc.github.io/mausVoice/).

### Debian / Ubuntu (.deb)

Download the latest `.deb` from the [download page](https://maus-inc.github.io/mausVoice/), then install it:

```bash
sudo dpkg -i mausVoice_*.deb
sudo apt-get install -f   # install any missing dependencies
```

Upgrade by downloading the newer `.deb` and repeating the `dpkg -i` command.

### AppImage

A standalone AppImage is also available on the [download page](https://maus-inc.github.io/mausVoice/). No installation required — just download, make executable, and run:

```bash
chmod +x mausVoice_*.AppImage
./mausVoice_*.AppImage
```

## Display Server Setup

Check which display server you are using:

```bash
echo $XDG_SESSION_TYPE
```

### X11

mausVoice uses `xdotool` to simulate paste keystrokes after placing transcribed text on the clipboard. Most X11 desktops have it pre-installed, but if not:

```bash
# Debian / Ubuntu
sudo apt install xdotool

# Fedora / RHEL
sudo dnf install xdotool

# openSUSE
sudo zypper install xdotool
```

No other setup is required — hotkeys work out of the box on X11.

### Wayland

Wayland compositors block app-level global key capture and input simulation by design. mausVoice handles this with compositor-level keybindings and kernel-level input simulation, but some one-time setup is required.

#### ydotool (required for text pasting)

mausVoice uses `ydotool` to simulate paste keystrokes after placing transcribed text on the clipboard. It works on all Wayland compositors by writing directly to `/dev/uinput` at the kernel level.

**Install:**

```bash
# Debian / Ubuntu
sudo apt install ydotool

# Fedora / RHEL
sudo dnf install ydotool

# openSUSE
sudo zypper install ydotool
```

**Grant your user access to /dev/uinput:**

```bash
# Add your user to the input group
sudo usermod -aG input $USER

# Create a udev rule so /dev/uinput is group-accessible
echo 'KERNEL=="uinput", GROUP="input", MODE="0660"' | sudo tee /etc/udev/rules.d/99-uinput.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Log out and back in for the group change to take effect.

**Verify it works:**

```bash
# Open a text editor, click into it, then run:
ydotool type "hello"
```

If "hello" appears in the editor, ydotool is working.

#### wtype (Sway/Hyprland only)

On Sway and Hyprland, mausVoice uses `wtype` as a fallback for input simulation via the virtual-keyboard Wayland protocol. This is not needed on GNOME.

```bash
# Debian / Ubuntu
sudo apt install wtype

# Fedora / RHEL
sudo dnf install wtype

# openSUSE
sudo zypper install wtype
```

#### Hotkey Registration

When you configure hotkeys in mausVoice's settings, the app automatically registers them with your compositor. However, Sway and Hyprland require a one-time config change to source mausVoice's keybinding file.

**GNOME** — no manual setup needed. mausVoice registers hotkeys via `gsettings` automatically.

**Sway** — add this line to `~/.config/sway/config`:

```
include ~/.config/sway/mausvoice-hotkeys
```

Then reload:

```bash
swaymsg reload
```

**Hyprland** — add this line to `~/.config/hypr/hyprland.conf`:

```
source = ~/.config/hypr/mausvoice-hotkeys.conf
```

Then reload:

```bash
hyprctl reload
```

## Known Limitations

### Recording pill not visible on older GNOME versions

The recording pill overlay uses the `wlr-layer-shell` protocol to render on top of other windows. Older versions of GNOME (prior to GNOME 46) do not support this protocol, so the pill will not appear. Hotkeys and transcription still work normally — only the visual indicator is affected.

This is a compositor limitation and cannot be worked around by mausVoice. Upgrading to GNOME 46 or later (Ubuntu 24.04+, Fedora 40+) will resolve this.
