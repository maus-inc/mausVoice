---
title: "Database and migrations"
description: "Add forward SQLite changes without breaking fresh installs, upgraded profiles, WAL files, or TypeScript normalization."
sidebar:
  order: 9
---

The on-disk file is `mausvoice.db` (`DB_CONNECTION` = `sqlite:mausvoice.db`). Query modules in `db/` include `api_key_queries`, `transcription_queries`, `preferences_queries`, `tone_queries`, and `hotkey_queries`.

SQLite SQL files live in `apps/desktop/src-tauri/src/db/migrations/`, but filenames alone do not register them. `db/mod.rs` must `include_str!` the file and add a `tauri_plugin_sql::Migration` with a unique version, stable description, SQL constant, and `Up` kind. Tauri installs that migration list for `sqlite:mausvoice.db` during startup; Rust query modules also access an SQLx pool.

The historical numbering is intentionally irregular. `000_schema.sql` is registered as version 1, `021` is absent, and the sequence runs through `069_consolidated_v0_1_6_schema.sql` and then `070_post_process_fallback.sql` — `069` being a single migration that folds every post-0.1.5 schema change (the former `071`-`088` files: cloud removal, enterprise drop, feature preferences, auto-learn, expansion flags, the update-channel column, and more) into the first step after `068`, the last migration the 0.1.5 release shipped. Files `058` and `059` share a stem, but 59 is a compatibility no-op with its own description. Do not rename, renumber, reorder, or rewrite an applied migration to make the directory look cleaner; extend the consolidated migration only while 0.1.6 remains unreleased. `071`-`088` are
  retired-era numbers with no step behind them — they are listed in
  `RETIRED_CONSOLIDATION_ERA_VERSIONS` and skipped on open — and `089` and `090` are already
  registered, so the next number for a shipped release is **091**, not 071.

A durable preference change usually needs all of these:

1. additive SQL for existing profiles and the correct value/nullability;
2. Rust preference/domain/query fields;
3. regenerated Tauri bindings when an exposed type changes;
4. TypeScript defaults, normalization, repository mapping, and UI behavior;
5. a fresh-profile test and an upgrade test from the oldest relevant schema.

Prefer forward transformations. SQLite has limited `ALTER TABLE`; copy/rename operations must preserve constraints and data deliberately. Consider profiles created under legacy product identities: `system/voquill_migration.rs` runs a staged, non-destructive upgrade from the flavor-matched Voquill profile (`com.voquill.desktop/voquill.db`, `.dev`, or `.local`, plus WAL/SHM/journal companions) into a temporary staging file, validates integrity and mausVoice migrations via `open_app_database_strict`, checkpoints the staged WAL into a standalone `DELETE`-mode database, and records status in `voquill-migration-state.json`. On first launch, startup promotes the staged database only when `mausvoice.db` does not yet exist. On Retry after a failed import, migration verifies that the active database still has no saved user data, moves the existing `mausvoice.db` and its sidecars to a temporary rollback backup, promotes the verified staged file, reopens the live pool, and restores the rollback backup automatically if promotion or reopen fails. Legacy databases from post-fork Voquill schemas (version 69+) fail explicitly as incompatible rather than being silently quarantined or overwritten, and the original Voquill files are left intact.

Never test destructive migration ideas on the only live profile. Copy the database plus WAL and SHM files while the app is fully closed. A fresh database proving startup is insufficient. Duplicate columns, stale nulls, removed enum values, and old tone/key records usually appear only on upgrade.
