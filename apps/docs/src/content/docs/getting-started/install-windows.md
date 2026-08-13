---
title: "Install on Windows"
description: "Install mausVoice on Windows and handle SmartScreen and input-capture setup."
sidebar:
  order: 4
---

Download the Windows installer from the latest [GitHub release](https://github.com/maus-inc/mausVoice/releases), then run it. Public release artifacts are currently unsigned, so Microsoft Defender SmartScreen may identify an unknown publisher.

## SmartScreen flow

1. Confirm that the installer came from `github.com/maus-inc/mausVoice/releases`.
2. In the SmartScreen dialog, choose **More info**.
3. Select **Run anyway**, then finish the installer.
4. Launch mausVoice from the Start menu and complete onboarding.

The installer includes the WebView2 bootstrapper required by the Tauri interface. If installation is interrupted, rerun the same installer before attempting manual WebView repairs.

## Input setup

mausVoice needs more than clipboard access to deliver text into another application. Settings can show a Windows input-setup action that grants administrator privileges and input-capture access; Windows displays a User Account Control prompt when that action runs. Complete it only from the installed mausVoice application.

The default Windows dictation shortcut is **Left Windows/Meta + Left Control**. If that combination is reserved by another utility, change **Settings → General → Hotkey shortcuts → Hold to dictate**. Test with Notepad before debugging a browser, game, terminal, or elevated application because those targets can impose their own input restrictions.
