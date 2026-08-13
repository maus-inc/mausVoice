---
title: "Clear local data"
description: "Understand the destructive reset before typing the confirmation word."
sidebar:
  order: 12
---

Open **Settings → Danger zone → Clear local data**. The confirmation dialog requires typing `clear` and warns that the action is irreversible.

The current command empties eight SQLite tables: chat messages, conversations, user profiles, transcriptions, terms, hotkeys, API keys, and user preferences. It then attempts to vacuum the database and reloads the interface. Use it when a genuine local reset is intended—not as the first response to a provider outage, permission problem, or one bad style.

Before confirming, copy any history text you need and note shortcuts, provider selections, and other preferences that will need to be rebuilt. The current table list does not include every persisted table—for example, writing styles and application-target records are not among the eight tables cleared—so do not use this control as proof that every database row is gone. The command does **not** delete the database file itself, downloaded models, log files, general app storage, or the audio files under `transcription-audio/`; clearing the transcription rows can leave those audio files without their History records. Inspect the documented data directories separately if the goal is complete removal. This is application-level cleanup, not secure whole-disk erasure.

API credentials are stored locally in encrypted form, and their database rows are cleared by this action, but account-side keys remain valid at the provider until revoked there. Clearing local data is not key rotation. If a credential may be exposed, revoke it in the provider console even after resetting mausVoice.
