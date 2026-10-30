---
title: "Clear local data"
description: "Understand the destructive reset before typing the confirmation word."
sidebar:
  order: 12
---

Open **Settings → Privacy and data → Danger zone → Clear local data**. The confirmation dialog requires typing `clear` and warns that the action is irreversible.

The current command empties fourteen SQLite tables, including chat messages, conversations, user profiles, transcriptions, terms, hotkeys, API keys, user preferences, tones (writing styles), app targets, paired remote devices, pending audio deletions, daily word totals, and their usage-event ledger. It deletes managed transcription audio and orphaned WAVs, clears the app-managed `storage/` directory, removes database quarantine backups and the previous-brand database copy, then attempts to vacuum the database and reload the interface. A failure in required file cleanup leaves local writes blocked and the clear available for retry. The vacuum is best effort after the logical deletion. Use this when a genuine local reset is intended, not as the first response to a provider outage, permission problem, or one bad style.

Before confirming, copy any history text you need and note shortcuts, provider selections, writing styles, app-target settings, and other preferences that will need to be rebuilt. The reset clears the app-managed `storage/` directory and managed transcription audio as well as the listed database tables, but it does **not** delete the database file itself, downloaded models, or log files. Startup also writes an operational `bridge-server.json` containing only the loopback bridge port; it is regenerated on launch and is not user content. The reset does not undo operating-system integrations such as compositor hotkey bindings or the Java Access Bridge entry in `~/.accessibility.properties`; those are stored outside mausVoice's data directories. Inspect the documented data directories and relevant system settings separately if the goal is complete removal. This is application-level cleanup, not secure whole-disk erasure.

mausVoice stores API credentials locally in encrypted form, and this action clears their database rows, but account-side keys remain valid until you revoke them at the provider. Clearing local data is not key rotation. If a credential may be exposed, revoke it in the provider console even after resetting mausVoice.
