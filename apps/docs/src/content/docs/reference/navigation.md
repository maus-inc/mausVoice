---
title: "Navigation and routes"
description: "Map desktop sidebar destinations, guarded setup screens, dialogs, and unfinished internal routes."
sidebar:
  order: 1
---

| Visible destination | What it owns                                                                                 | Internal route              |
| ------------------- | -------------------------------------------------------------------------------------------- | --------------------------- |
| Home                | Current status, dictation entry points, and dashboard summaries                              | `/dashboard`                |
| History             | Saved transcripts, details, audio, export, deletion, and reprocessing                        | `/dashboard/transcriptions` |
| Dictionary          | Glossary terms plus deterministic replacement/snippet rules                                  | `/dashboard/dictionary`     |
| Styles              | Manual/application styling and style creation/editing                                        | `/dashboard/styling`        |
| Chats               | Saved Assistant conversations; shown only when Assistant is enabled                          | `/dashboard/chats`          |
| Settings            | Devices, processing, provider keys, permissions, privacy, diagnostics, and advanced behavior | `/dashboard/settings`       |

Settings remains anchored at the bottom of the desktop sidebar; an available-update tile can appear above it. On narrow window widths, the persistent sidebar is hidden, so use the available compact navigation rather than resizing below the configured 800 px minimum.

Before the dashboard, guards can send a profile to `/welcome`, `/login`, or `/onboarding`. `/` redirects to `/dashboard`, after which guards choose the valid state. User instructions should name the visible screen/control rather than telling people to type these webview-internal URLs.

Many tasks open dialogs without creating routes. Examples include microphone/audio, diagnostics, hotkeys, API-provider selection, Assistant setup, More Settings, clear-local-data, profile, permissions, transcription details/retranscription, and the style editor. Closing one returns to its owning routed page.

The router also defines `/dashboard/apps`. Its current page promises MCP/integrations but renders an empty item list, and the sidebar does not link it. Treat it as a source-level placeholder, not a shipped integration marketplace or supportable feature.
