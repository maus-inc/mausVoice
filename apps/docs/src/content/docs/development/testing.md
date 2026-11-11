---
title: "Testing and CI"
description: "Select the right frontend, provider, Rust, pill, docs, build, and binding checks for a change."
sidebar:
  order: 10
---

Root `build`, `lint`, `check-types`, and `test` commands use Turbo and run only tasks defined by each workspace. `check-types` and `test:evals` depend on `^build` so compiled package `dist/` exists first.

Eval tests (`test:evals`) score LLM cleanup against styles (Polished/Default, Email, Chat, Formal) and multilingual cases. They do not currently assert Verbatim. They are not a substitute for unit tests. Integration transcription tests split long WAV fixtures into overlapping segments and compare merged text to a gold transcript. For desktop changes, use the more explicit scripts:

```bash
pnpm --filter desktop lint
pnpm --filter desktop test:unit
pnpm --filter desktop test:integration
pnpm --filter desktop test:evals
pnpm --filter desktop test:webdriver
```

Unit tests under `apps/desktop/src` cover repositories, prompt/AI parsing, local-sidecar normalization, key handling, limits, trays, recommendations, and UI contracts. Integration/eval tests under `apps/desktop/test` use checked-in WAV/text fixtures and may call providers. The GitHub integration workflow injects only `GROQ_API_KEY` and skips fork pull requests because secrets are withheld; do not "fix" a fork failure by exposing credentials.

Run Rust backend unit tests from `apps/desktop/src-tauri` with `cargo test --lib`. Native pill workflows run Clippy/tests selectively by host; `rust_pill_shared` has geometry/ring tests. Compile all affected platform adapters in CI; one OS passing does not prove another.

For local transcription, the non-ignored integration test exercises the sidecar binary/API without a model. The ignored test downloads Tiny and transcribes the fixture. CI currently runs both serially on Ubuntu, Windows, and macOS, so changes to downloads or timing must respect the 45-minute job limit.

Docs validation is:

```bash
pnpm --filter docs check-types
pnpm --filter docs build
node --test scripts/ci/pr28-contracts.test.mjs
```

The docs workflow also rejects root-relative Markdown links, assembles the landing page and docs artifact, and smoke-tests the custom root 404, fonts, assets, sitemap, and canonical URLs. Regenerate/check native bindings after exposed Rust changes. A green focused test is necessary, not a substitute for the build/lint checks covering the changed boundary.
