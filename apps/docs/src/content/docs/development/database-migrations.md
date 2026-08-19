---
title: "Database and migrations"
description: "Add forward SQLite changes without breaking fresh installs, upgraded profiles, WAL files, or TypeScript normalization."
sidebar:
  order: 9
---

The on-disk file is `mausvoice.db` (`DB_CONNECTION` = `sqlite:mausvoice.db`). Query modules in `db/` include `api_key_queries`, `transcription_queries`, `preferences_queries`, `tone_queries`, and `hotkey_queries`.

SQLite SQL files live in `apps/desktop/src-tauri/src/db/migrations/`, but filenames alone do not register them. `db/mod.rs` must `include_str!` the file and add a `tauri_plugin_sql::Migration` with a unique version, stable description, SQL constant, and `Up` kind. Tauri installs that migration list for `sqlite:mausvoice.db` during startup; Rust query modules also access an SQLx pool.

The historical numbering is intentionally irregular. `000_schema.sql` is registered as version 1, `021` is absent, and the current sequence extends through `077` (with recent additions `075_tone_structured_fields.sql`, `076_feature_preferences.sql`, and `077_spoken_commands_enabled.sql`). Files `058` and `059` share a stem, but 59 is a compatibility no-op with its own description. Do not rename, renumber, reorder, or rewrite an applied migration to make the directory look cleaner.

A durable preference change usually needs all of these:

1. additive SQL for existing profiles and the correct value/nullability;
2. Rust preference/domain/query fields;
3. regenerated Tauri bindings when an exposed type changes;
4. TypeScript defaults, normalization, repository mapping, and UI behavior;
5. a fresh-profile test and an upgrade test from the oldest relevant schema.

Prefer forward transformations. SQLite has limited `ALTER TABLE`; copy/rename operations must preserve constraints and data deliberately. Consider profiles created under legacy product identities: `system/paths.rs` can migrate `com.voquill.desktop/voquill.db` and its `-wal`/`-shm` companions.

Never test destructive migration ideas on the only live profile. Copy the database plus WAL and SHM files while the app is fully closed. A fresh database proving startup is insufficient—duplicate columns, stale nulls, removed enum values, and old tone/key records usually appear only on upgrade.
