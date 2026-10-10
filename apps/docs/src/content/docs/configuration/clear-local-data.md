---
title: "Clear local data"
description: "Understand the destructive reset before typing the confirmation word."
sidebar:
  order: 12
---

Open **Settings → Account → Danger zone → Clear local data**. The confirmation dialog lists what will be removed, then requires typing `clear`; the action is irreversible, and the dialog says so.

The current command empties eleven SQLite tables: chat messages, conversations, user profiles, transcriptions, terms, hotkeys, API keys, user preferences, tones (writing styles), app targets, and paired remote devices. It attempts to delete the audio files referenced by transcriptions from the managed `transcription-audio/` directory (through a canonicalized path guard), sweeps orphaned WAVs there, then attempts to vacuum the database. Before the interface reloads, it also removes everything the app itself wrote to this device's browser storage: the persisted preferences and local state (including the profile picture), the account-created and onboarding anchors, the remembered last settings page, the onboarding checklist and dismissed-tip flags, denied auto-learn terms, pending transcription deletes, and the per-tool agent auto-approvals. Signed-in session keys are left alone, because clearing local data is not a sign-out. If the browser refuses to delete any of it, the dialog says so and does not reload, so the surviving state is not mistaken for a completed reset. Use it when a genuine local reset is intended, not as the first response to a provider outage, permission problem, or one bad style.

Before confirming, copy any history text you need and note shortcuts, provider selections, writing styles, app-target settings, and other preferences that will need to be rebuilt. The table list covers user-content tables, but it is not a proof that every database row is gone. The command does **not** delete the database file itself, downloaded models, log files, or general app storage. Inspect the documented data directories separately if the goal is complete removal. This is application-level cleanup, not secure whole-disk erasure.

mausVoice stores API credentials locally in encrypted form, and this action clears their database rows, but account-side keys remain valid until you revoke them at the provider. Clearing local data is not key rotation. If a credential may be exposed, revoke it in the provider console even after resetting mausVoice.
