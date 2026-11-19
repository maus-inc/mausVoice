---
title: "App tour"
description: "Find Home, History, Dictionary, Styles, Chats, and Settings in the current desktop interface."
sidebar:
  order: 1
---

The main window uses a left navigation rail. Its route labels are the most reliable landmarks when a guide tells you where to change something.

- **Home** is the default dashboard. It shows current streak, words this month, lifetime words, recent dictations, and a daily activity chart for the past 53 calendar weeks. Dictation speed appears when recent saved recordings include audio-duration data.

The activity chart groups dictations by the device's local calendar date. The dashboard stores daily word totals locally without copying transcript text into the activity records.

- **History** lists saved transcriptions and opens their details.
- **Dictionary** manages glossary hints and replacement rules.
- **Styles** manages the writing instructions applied during post-processing.
- **Chats** appears only when Assistant mode is enabled.
- **Settings** sits at the bottom of the rail and contains device, shortcut, processing, diagnostic, and advanced controls.

An internal `/dashboard/apps` route also exists, but it is currently a placeholder for future MCP/integration work and is not presented as a finished user feature.

The native recording pill is a separate platform window/process. It remains visible over other applications when supported, reflects recording state, and can be repositioned. Closing or hiding the main dashboard does not turn the pill into an editor; dictated text still targets the application with focus.
