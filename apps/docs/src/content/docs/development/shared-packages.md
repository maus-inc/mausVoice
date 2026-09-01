---
title: "Shared packages"
description: "Choose the owning workspace for domain contracts, providers, agent logic, native bindings, hooks, utilities, and fonts."
sidebar:
  order: 8
---

Use the narrowest package that can own behavior without importing the desktop application's state graph.

- `@maus-inc/types` exports cross-workspace domain interfaces plus selected Zod schemas for providers, dictionaries, tools, chats, targets, preferences, and remote output.
- `@maus-inc/utilities` contains dependency-light collection, string, equality, math, member, and retry/batching helpers. Its string behavior has Vitest coverage.
- `@maus-inc/voice-ai` owns provider request/response utilities for the hosted and compatible AI routes. Its package description still says Groq, but current source covers many providers; source exports are authoritative.
- `@repo/agent` is the provider-agnostic tool loop. The desktop supplies model/tool implementations and persists conversations around it.
- `@maus-inc/desktop-native-apis` contains generated TypeScript wrappers around Tauri invokes. Regenerate it from Specta-facing Rust changes.
- `@maus-inc/desktop-utils` supplies reusable activation, hotkey, platform, Tauri-event/listener, key, and updater logic. React and Tauri are peer dependencies.
- `@maus-inc/firemix` wraps Firemix/Firebase path helpers and expects Firebase as a peer; it does not prove that an `apps/firebase` service exists in this checkout.
- `shared-fonts` holds tracked Satoshi and TAN Paradiso source assets. The docs copy what they serve into their own public assets.

`eslint-config` and `typescript-config` centralize tooling presets. Native pill and transcription crates are Cargo packages, not pnpm packages, even though they live under `packages/`.

Turbo builds TypeScript dependencies first via `dependsOn: ["^build"]`. Do not introduce a reverse dependency from low-level types/provider code to `apps/desktop`; pass contracts or callbacks downward instead. Several package manifests retain old repository metadata, so use current `maus-inc/mausVoice` paths in new links.
