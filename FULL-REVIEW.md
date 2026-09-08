# mausVoice End-to-End Review Protocol

This document defines the required review process for `mausVoice`.

The process applies to pull requests that change application code, tests,
generated output, dependencies, build scripts, workflows, configuration,
release artifacts, or documentation that changes an operational contract.

The review goal is to find defects introduced, exposed, or made reachable by
the pull request. Do not report pre-existing defects unless the pull request
makes them worse, exposes them, or prevents a safe fix.

This protocol has four parts:

1. **Part I — Review Procedure** defines the required review actions,
   evidence rules, and phase gates.
2. **Part II — Project Risk Catalog** defines conditional, mausVoice-specific
   checks distilled from historical PR findings (Rust/Tauri backend,
   React/TypeScript frontend, CI/CD, and monorepo).
3. **Part III — Operational Changes and Automation Backlog** defines the
   repository changes that make the procedure repeatable.
4. **Part IV — External References (non-normative)** pins the external
   review skills this protocol builds on — the CodeRabbit CLI review skill,
   the two-axis Standards/Spec review skill, the iterative review-loop skill,
   and the multi-axis code-review-and-quality skill — and states how each
   informs the procedure.

Part I is the sole normative process. Parts II through IV are conditional
checks, operational backlog, and reference material. If guidance conflicts,
Part I and `AGENTS.md` take precedence.

A reviewer must not treat a catalog item as a finding by itself.
A finding requires evidence that the pull request creates a reachable defect.

---

# Part I — Review Procedure

## 1. Terms, Review Contract, and Evidence Rules

### 1.1 Terms

| Term         | Meaning                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------ |
| Contract     | An observable promise to a caller, user, operator, system, or test.                        |
| Boundary     | A point where data, authority, lifecycle ownership, or failure ownership changes.          |
| Evidence     | A code trace, test result, CI result, reproduction, specification, or runtime observation. |
| Verification | A command, test, inspection, or manual scenario that checks a contract.                    |
| Risk         | The required review depth for a changed area. Risk is not finding severity.                |
| Finding      | A confirmed defect introduced or made reachable by the pull request.                       |
| Assumption   | A statement that has not been verified.                                                    |
| Unknown      | A required fact that cannot be obtained from the pull request, repository, or CI.          |

### 1.2 Review Contract

A review must:

1. Compare the reviewed head SHA with the target branch.
2. Read the complete diff before making line-level findings.
3. Inventory changed contracts before selecting verification.
4. Identify every changed behavior, contract, and operational surface.
5. Trace each changed public boundary to its consumers.
6. Review successful, failed, cancelled, retried, and shutdown paths.
7. Inspect tests for both coverage and test validity, independently from
   implementation correctness.
8. Run or inspect every relevant verification gate, and record verification
   status without claiming unrun checks passed.
9. Report only findings with a clear cause, impact, and minimal safe fix that
   meet the finding validation requirements (Section 10).
10. Separate verified facts from assumptions and unknowns.
11. Stop only when all required phase gates have an explicit result.

A review must not:

- Report a style preference as a correctness finding.
- Claim a command passed when it was not run.
- Require a named implementation pattern when another implementation preserves
  the same contract. (For example, a changed Tauri command does not always
  need a discriminated-union result.)
- Infer desktop-runtime behavior only from a mocked unit test.
- Infer migration safety only from a fresh-database test.
- Infer cross-platform behavior from one platform target.
- Treat a test as valid when it can pass while the changed contract is broken,
  or when it only repeats implementation constants.
- Report a pre-existing issue unless the pull request makes it worse, makes it
  reachable, or blocks its safe repair.
- Mark CI as passing when a required check is pending, unavailable, or
  inconclusive.

### 1.3 Evidence Quality

Use the strongest available evidence.

| Evidence level | Evidence                                             | Allowed conclusion                     |
| -------------- | ---------------------------------------------------- | -------------------------------------- |
| E0             | Intent in PR text or comments                        | Intended behavior only                 |
| E1             | Static inspection of changed code                    | Plausible code path                    |
| E2             | Consumer trace or focused test inspection            | Reachability or contract coverage      |
| E3             | A test or command completed on the reviewed head SHA | Verified behavior within test scope    |
| E4             | Desktop integration or end-to-end scenario completed | Verified user-visible runtime behavior |
| E5             | Reproduction on relevant platform and state          | Confirmed real defect                  |

Do not describe an E1 conclusion as an E4 conclusion.

Treat pull request text as intent. Treat code and tests as implementation.
Treat CI output as verification evidence.

---

## 2. Review Inputs and Evidence Ledger

Collect the following before detailed analysis:

- Target branch and reviewed head SHA.
- Pull request title, description, linked issues, and prior discussion.
- Full diff, including renamed, deleted, generated, lock, workflow, and
  configuration files.
- Changed files and changed symbols.
- Existing tests close to each changed behavior.
- CI jobs, their status, and their exact commands.
- Relevant repository instructions (`AGENTS.md`, `CLAUDE.md`).
- Relevant Tauri configuration, capabilities, permissions, CSP, migrations,
  package manifests, Cargo manifests, generated-binding sources, and workflows.

Create an evidence ledger before writing findings.

| ID   | Contract or concern                              | Evidence source                                  | Evidence level | Result                | Follow-up                |
| ---- | ------------------------------------------------ | ------------------------------------------------ | -------------- | --------------------- | ------------------------ |
| E-01 | Existing SQLite files upgrade safely             | Migration implementation and integration test    | E3             | Verified / Unverified | Add test or inspect path |
| E-02 | A command remains inaccessible to remote content | Tauri capability and `remote.urls` configuration | E2             | Verified / Unverified | Security phase           |
| E-03 | A React cleanup releases a media stream          | Hook cleanup and test                            | E2             | Verified / Unverified | Lifecycle phase          |

Use stable identifiers when one concern spans multiple files.

---

## 3. Phase 0: Scope, Baseline, and Change Inventory

### 3.1 Establish the Baseline

Before reviewing behavior:

1. Identify the base branch and reviewed head SHA.
2. Check whether the branch contains merge conflicts and whether an automated
   rebase is safe.
3. Identify commits that belong to the pull request.
4. Identify generated files, lockfiles, and vendored output.
5. Identify changed dependency versions and workspace overrides.
6. Identify deleted tests, disabled checks, and reduced assertions.
7. Identify changed feature flags, environment variables, and defaults.
8. Identify configuration changes that affect development, CI, release, or
   production behavior differently.

Do not assume a file is generated from its filename.
Find the generator, script, build step, or repository instruction.

### 3.2 Build the Change Inventory

Create one inventory record for each changed contract. A single file can have
multiple records.

| Area                 | Files                      | Change type  | Changed contract                                             | Entry point   | Consumers            | Risk   | Required verification                     |
| -------------------- | -------------------------- | ------------ | ------------------------------------------------------------ | ------------- | -------------------- | ------ | ----------------------------------------- |
| Database startup     | `src-tauri/src/db/open.rs` | Persistence  | Invalid migration history creates a recoverable startup path | App setup     | SQLite consumers     | High   | Integration tests, recovery trace         |
| Global error overlay | `src/utils/...`            | UI lifecycle | Mounted UI remains usable after non-fatal runtime errors     | Window events | React root and users | Medium | Unit tests and event classification trace |

For each changed file, at minimum record:

| Field                 | Required content                                                                        |
| --------------------- | --------------------------------------------------------------------------------------- |
| File                  | Repository-relative path                                                                |
| Change type           | Behavior, API, persistence, security, UI, tests, CI, dependency, docs, generated output |
| Changed contract      | What callers, users, or operators can observe                                           |
| Entry points          | Commands, exported functions, routes, hooks, event listeners, workflows, scripts        |
| Consumers             | Callers, IPC clients, database readers, UI components, CI jobs                          |
| Risk level            | Critical, high, medium, or low                                                          |
| Required verification | Tests, type checks, lint, build, manual scenario, security inspection                   |

Use the highest applicable risk level:

| Risk     | Examples                                                                                                                                                                      | Minimum review depth                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Critical | Native command permissions, arbitrary filesystem access, secret handling, updater trust, authentication, remote-content access with IPC, destructive migration or data action | Full security, contract, test, and verification review  |
| High     | SQLite migrations, persistence recovery, subprocesses, model downloads, audio devices, async lifecycle, cross-platform behavior, workflow changes, release artifacts          | Full contract and lifecycle review with direct evidence |
| Medium   | Stateful UI, IPC client changes, validation, error handling, dependency changes, generated bindings                                                                           | Consumer trace, tests, targeted verification            |
| Low      | Isolated rendering, copy, comments, formatting, non-operational docs                                                                                                          | Diff inspection and relevant local checks               |

Do not use risk level as severity. Risk level selects review depth.
Severity describes the impact of a confirmed finding.

### 3.3 Select Required Review Modules

For each inventory record, select relevant modules:

| Change type                  | Required modules                                                 |
| ---------------------------- | ---------------------------------------------------------------- |
| React component or hook      | Contract, lifecycle, accessibility, tests                        |
| Tauri command or IPC binding | Contract, IPC trace, security, generated-output check, tests     |
| SQLite migration or recovery | Persistence, rollback, compatibility, recovery, tests            |
| File operation               | Security, path and symlink analysis, error cleanup, tests        |
| Download or model artifact   | Network, integrity, cleanup, retry, tests                        |
| Subprocess                   | Authority, bounded I/O, timeout, cleanup, tests                  |
| Dependency or lockfile       | Supply chain, consumer impact, CI/build verification             |
| GitHub Actions workflow      | Trigger, path filter, permission, secret, platform matrix review |
| Native pill crate            | Platform-specific behavior, geometry, lifecycle, platform tests  |
| Documentation                | Contract accuracy, command accuracy, operational impact          |

If a module is not selected, record `Not applicable` with a reason.
A docs-only change must not receive the same audit depth as a Tauri command
or database migration — but the record and reason must exist.

---

## 4. Phase 1: Diff, Symbol, and Boundary Trace

Review the complete diff before reviewing individual lines.

For every changed exported symbol, command, configuration key, schema,
migration, workflow input, or environment variable:

1. Find its declaration or source of truth.
2. Find direct consumers and call sites.
3. Find indirect consumers through wrappers, hooks, generated bindings, or
   configuration.
4. Find existing tests that claim to cover it.
5. Find adjacent contracts, types, schemas, or generated outputs.
6. Find error, cancellation, cleanup, and rollback paths.
7. Find persisted state and compatibility dependencies.
8. Find platform-specific branches when the change reaches Tauri, native
   crates, filesystem paths, audio, windows, or build tooling.
9. Record the trace in the evidence ledger.

### 4.1 Required Boundary Traces

Trace the complete boundary when it changes.

| Changed boundary                  | Required trace                                                               |
| --------------------------------- | ---------------------------------------------------------------------------- |
| React component ↔ hook            | Props, state ownership, effect lifecycle, loading and error states           |
| React ↔ Tauri invoke              | Payload construction, serialization, rejection handling                      |
| TypeScript binding ↔ Rust command | Binding source, generated output, command registration, payload types        |
| Rust command ↔ filesystem         | Validation, canonicalization, authorization, operation target, cleanup       |
| Rust command ↔ subprocess         | Executable selection, arguments, I/O bounds, timeout, kill, reap             |
| Rust command ↔ SQLite             | Transaction, migration state, rollback, retry, recovery                      |
| Migration ↔ existing database     | Fresh install, upgrade, failed prior migration, changed checksum, corruption |
| Workflow ↔ build input            | Trigger, path filters, cache key, permissions, platform job                  |
| Tauri configuration ↔ webview     | `remote.urls`, capabilities, permissions, CSP, custom protocol use           |
| Package manifest ↔ lockfile       | Dependency declaration, resolution, workspace consumer, CI build path        |

### 4.2 Generated Artifacts

For generated files:

1. Identify the source of truth.
2. Identify the generation command or build path.
3. Verify that generated output matches the source.
4. Verify that a generated-file change does not hide a source change.
5. Do not recommend manual edits to generated output.
6. Report a stale artifact only when source and output disagree.

For Tauri command bindings, use the Rust command source and the configured
binding generation path as the source of truth: regenerate through
`pnpm gen:bindings` (which runs `scripts/bindings.sh`) and verify with
`scripts/check-bindings.sh`. `bindings.ts` must not become a separate
manually maintained contract.

### 4.3 Dependency Changes

For each changed dependency:

- Identify direct and transitive consumers.
- Identify whether the change affects desktop runtime, build tooling, CI, or
  release packaging.
- Confirm the lockfile (`pnpm-lock.yaml`, `Cargo.lock`) matches the manifest
  change.
- Check workspace overrides and version floors.
- Check whether a native dependency needs platform-specific build tools.
- Check whether the update changes a security, network, filesystem, IPC, or
  serialization boundary.
- Record any verification that runs the affected consumer.

Do not report "dependency updated without tests" unless the dependency change
has a reachable contract impact and no relevant verification exists.

---

## 5. Phase 2: Contract Review

Define each changed behavior before judging its implementation.

Use this format:

```text
Given: [initial state, platform, persisted state, and valid input]
When:  [user action, command, event, retry, startup, or shutdown]
Then:  [observable result]
And:   [failure, cancellation, cleanup, rollback, and retry result]
```

For stateful behavior, also define:

```text
Invariant: [a condition that must remain true]
Owner:     [the component, process, transaction, or module responsible]
End state: [the required state after success, failure, and cancellation]
```

### 5.1 Input and Output Review

Check these conditions where applicable:

- The receiving boundary validates untrusted input.
- Rust and JavaScript numeric values remain safe across serialization
  (`u64` → JS `Number` precision).
- Empty values, missing fields, `null`, `undefined`, malformed JSON, and
  invalid enum variants have defined behavior.
- Error values do not expose secrets, filesystem paths, or internal state to
  an untrusted caller.
- Each caller receives the result shape it expects.
- Defaults do not silently change behavior for existing users.
- Serialization preserves field naming, optionality, and compatibility.
- The change did not alter a public API, serialized value, or user-visible
  state without a matching consumer update.
- A user-visible state has explicit pending, success, empty, and error behavior
  where each state is possible.

### 5.2 Failure, Recovery, and Retry Review

For each operation that can fail:

1. Identify the failure owner.
2. Identify the state before failure and the state after failure — does
   failure preserve a valid state?
3. Identify cleanup and rollback: does a partial operation roll back,
   compensate, or recover safely?
4. Identify what retry does, and whether retry is idempotent (no duplicate
   work, corrupted state, or leaked resources).
5. Identify whether failure is logged, surfaced at the correct layer, or
   intentionally suppressed.
6. Identify whether failure blocks startup or permits degraded operation —
   startup must remain usable when recovery is an explicit product
   requirement.

A recovery path must preserve diagnostic evidence when the product requires it.
For example, database quarantine must preserve the original database and its
relevant SQLite sidecars before creating a fresh database.

### 5.3 Concurrency and Lifecycle Review

For async or long-lived work, identify: start owner, cancellation owner,
completion owner, cleanup owner, resource owner, stale-result rejection
mechanism, shutdown behavior, and retry/replacement behavior.

Check for:

- Stale async completion overwriting newer state.
- Callbacks that run after unmount, shutdown, cancellation, or replacement.
- Event listeners that remain after teardown.
- Timers, listeners, streams, child processes, database transactions, and file
  handles that remain after failure or cancellation.
- Shared mutable state without a session, request, or generation identity.
- Mutexes held across `await` points, I/O, inference, or other long-running work.
- Global cancellation that crosses session boundaries.
- Duplicate work from repeated user actions or automatic retries.

### 5.4 Compatibility Review

For persisted or platform-sensitive changes, check:

- Fresh install behavior.
- Upgrade behavior from a previous supported release — can an existing user
  database, config file, cache, or saved setting still load?
- Migrations support both fresh and existing installations.
- Interrupted prior operation behavior.
- Corrupted or manually modified persisted state behavior.
- Missing optional asset or unavailable hardware behavior degrades safely.
- Windows, macOS, and Linux behavior is equivalent where the contract is shared.
- Existing configuration, cache, model, database, and preference compatibility.

---

## 6. Phase 3: Security and Authority Review

Run this phase for all Critical and High risk records.
Run relevant subsections for every other record.

### 6.1 Threat Model Record

For each security-sensitive record, write:

| Field             | Required content                                                                |
| ----------------- | ------------------------------------------------------------------------------- |
| Asset             | Database, local file, model artifact, microphone, native command, release key   |
| Attacker control  | URL, IPC payload, file path, archive entry, database content, workflow event    |
| Trust boundary    | Webview to Tauri, command to OS, CI event to secrets, download to disk          |
| Required property | No traversal, no unauthorized invoke, integrity preserved, bounded resource use |
| Enforcement point | Validation function, capability, CSP, transaction, workflow permission          |
| Test or evidence  | Rejected-input test, config trace, integration test, CI inspection              |

### 6.2 Webview and Tauri Authority

Check:

- `remote.urls` only authorizes content that must receive native authority;
  restrict Tauri command access to trusted application content.
- External pages do not gain IPC or native command access.
- Capabilities and permissions grant the minimum required authority.
- CSP permits required application assets but does not unnecessarily permit
  remote scripts or unsafe execution.
- Custom protocols validate inputs and do not expose arbitrary local content.
- New commands are registered only when intended.
- Every externally controllable command field is validated before filesystem,
  process, network, or database operations.

### 6.3 Filesystem Authority

For scoped file operations:

1. Validate the intended path format; reject path traversal and unsafe
   absolute paths where a scoped path is required.
2. Resolve the allowed base directory.
3. Canonicalize existing path components before authorization checks.
4. Check symlink behavior, including the final path component.
5. Construct and perform operations on the validated `PathBuf`, not the raw
   input.
6. Clean up partial output on failure.
7. Test deletion, replacement, extraction, traversal, absolute-path, and
   symlink-escape behavior where applicable.

A lexical prefix check alone does not prove containment.

### 6.4 Network, Downloads, and Subprocesses

For network operations:

- Restrict schemes, hosts, redirects, and redirect count when downloading
  trusted artifacts; validate each redirect target.
- Enforce size limits during streaming, not only from `Content-Length`.
- Define behavior for missing `Content-Length`.
- Verify artifact integrity when the artifact has a trusted checksum or signature.
- Remove partial artifacts after a failed or cancelled download.
- Define retry behavior.

For subprocesses:

- Use explicit executable allow-lists; restrict executable selection.
- Avoid shell interpolation unless explicitly required and safely controlled.
- Bound captured stdout and stderr.
- Drain stdout and stderr without deadlock.
- Kill and reap timed-out child processes.
- Preserve useful diagnostics without exposing secrets.
- Test timeout, non-zero exit, large output, and cancellation paths where relevant.

### 6.5 CI, Release, and Secret Boundaries

Check:

- Workflow job permissions use least privilege, set at the job level.
- Fork-triggered workflows cannot access privileged secrets.
- Release-only secrets enter only through protected CI configuration.
- Signing keys, tokens, credentials, trust anchors, and updater private
  material are not committed.
- Updater trust configuration cannot be changed by untrusted pull requests.
- Cache keys include inputs that affect generated or compiled output.
- Path filters include all relevant build inputs.
- Release jobs run only under intended events and branches.

---

## 7. Phase 4: Test Review and Test Validity

Review test quality separately from implementation correctness.

### 7.1 Evidence Classification

For every changed behavior, classify evidence:

| Classification  | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| Direct test     | Exercises the changed contract through its public boundary. |
| Indirect test   | Covers the contract only as part of a larger flow.          |
| Regression test | Fails before the change and passes after the change.        |
| Negative test   | Confirms rejected input or failure handling.                |
| Recovery test   | Confirms safe post-failure state and retry behavior.        |
| Missing test    | No evidence protects a meaningful changed contract.         |
| Invalid test    | Can pass while the required behavior is broken.             |

### 7.2 Test Validity Questions

For each relevant test, ask:

1. Would the test fail if the changed behavior reverted?
2. Does the test use the public contract rather than an implementation detail?
3. Does the test mock the function or module that contains the behavior under
   test?
4. Does the assertion come from an independent source of truth, or does it
   assert a duplicated hardcoded value instead of runtime or schema-derived
   state?
5. Does the test verify both success and relevant failure behavior?
6. Does the test wait on deterministic readiness rather than elapsed time
   (sleeps)?
7. Does the test restore global state and isolate filesystem, environment, and
   static mutation?
8. Can the test pass only because a mock has the same bug as production code?
9. Does the test protect an existing-user state, not only a fresh state?
10. Does the test distinguish a visible UI result from an internal helper call?
11. Does the test distinguish the old behavior from the required new behavior?

### 7.3 Required Test Types

| Changed area                              | Minimum evidence                                                    |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Pure deterministic function               | Unit test with boundary and error cases                             |
| React hook or state transition            | Unit or component test with mount, update, and cleanup behavior     |
| New public command or changed IPC payload | Binding and Rust command contract test                              |
| Filesystem operation                      | Temporary-directory integration test with rejected-path coverage    |
| SQLite migration                          | Fresh database, upgrade, failure, rollback/recovery tests           |
| Database quarantine                       | Original database preservation, sidecar handling, fresh reopen test |
| Download or model installation            | Failure cleanup, integrity, retry, and readiness tests              |
| Subprocess management                     | Exit, timeout, cancellation, and output-bound tests                 |
| Bug fix with a reproducible failure mode  | Regression test                                                     |
| Security boundary                         | Rejected-input tests                                                |
| Cross-platform logic                      | Tests where platform behavior differs                               |
| Workflow or release config                | Static workflow inspection and relevant CI evidence                 |
| Critical desktop flow                     | Desktop runtime or Webdriver end-to-end scenario                    |

Prefer the smallest test level that proves the contract.
Use unit tests for pure logic.
Use integration tests for persistence, IPC, filesystem, and module boundaries.
Use Webdriver end-to-end tests for critical user flows that require the
desktop runtime.

### 7.4 Test Anti-Patterns

Treat these as test-quality concerns when they affect changed behavior:

- Hardcoded expected schema duplicated from production constants.
- Mocks that replace the function containing the behavior under test.
- Assertions only on implementation calls, not observable results.
- Fixed sleeps when a state, event, or readiness condition exists.
- Tests that do not await async cleanup.
- Tests that mutate global state without restoration.
- Tests that use a fresh database for a migration-only contract.
- Tests that validate a checksum using a vector generated by the same changed
  implementation.
- Tests that assert an error was logged but do not assert safe state recovery.
- Tests with no failure assertion for a new error or recovery path.

---

## 8. Phase 5: Desktop End-to-End Scenarios

Unit and integration tests do not replace desktop-runtime validation for
critical user flows.

Select scenarios from the change inventory.

### 8.1 Startup and Recovery

For startup, migration, asset, or overlay changes, verify:

1. Fresh profile starts successfully.
2. Existing valid profile starts successfully.
3. Failed prior migration follows the documented recovery path.
4. Checksum mismatch follows the documented recovery path.
5. Corrupted database follows the documented recovery path.
6. Non-integrity startup failure does not destroy user data.
7. Missing script or stylesheet before mount shows the intended fatal behavior.
8. Post-mount runtime errors do not hide an already usable UI.
9. Non-script resource errors do not cause a fatal overlay unless the contract
   explicitly requires it.
10. Logs contain useful error context without containing secrets.

### 8.2 Audio and Transcription

For microphone, device, or model changes, verify:

1. No device is available.
2. The default device has no stable display name.
3. The user changes devices during an active operation.
4. The component unmounts during recording or inference.
5. Model artifacts are incomplete or download fails.
6. Cancellation does not cancel a later session.
7. Resource indicators and hardware handles are released after completion,
   failure, and cancellation.

### 8.3 Cross-Platform Native UI

For pill, window, geometry, shortcut, or native integration changes, verify:

- Primary supported platform behavior.
- Relevant behavior in every changed platform crate.
- Multi-monitor and edge-of-screen placement when geometry changes.
- Keyboard shortcut behavior on macOS (`Cmd`) and non-macOS (`Ctrl`) platforms.
- Failure behavior when an OS feature or permission is unavailable.

Record the tested platform and version. Do not generalize one platform result
to all platforms.

---

## 9. Phase 6: Verification Matrix

Select verification from the change inventory. Use exact repository commands
from CI, package scripts, Cargo manifests, or documented project instructions.
All commands below are confirmed by this repository's `package.json` scripts
and `.github/workflows/*.yml`.

### TypeScript and React changes

```sh
pnpm --filter desktop run lint            # prettier --check src && oxlint src
pnpm --filter desktop run check-types     # tsc --noEmit
pnpm --filter desktop run test:unit       # vitest run src
pnpm --filter desktop run test:integration  # vitest run test/integration
```

For critical desktop user flows, also verify:

```sh
pnpm --filter desktop run test:webdriver  # wdio run webdriver/wdio.conf.js
```

CI builds workspace dependencies first with
`pnpm exec turbo run build --filter=desktop^...` — do the same locally before
type checks to avoid spurious `TS2307` results.

### Rust and Tauri changes

Use the exact crate directory and feature set that CI uses:

```sh
# in apps/desktop/src-tauri — CI sets TAURI_CONFIG for the desktop Rust checks,
# so set it inline to reproduce the CI result exactly
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo clippy -- -D warnings
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib

# native pill crates (CI runs these per platform)
cargo clippy --manifest-path packages/rust_windows_pill/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path packages/rust_macos_pill/Cargo.toml --all-targets -- -D warnings
cargo clippy --manifest-path packages/rust_gtk_pill/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path packages/rust_windows_pill/Cargo.toml
cargo test --manifest-path packages/rust_pill_shared/Cargo.toml

# transcription sidecar integration
cargo test --manifest-path packages/rust_transcription/Cargo.toml --test sidecar_integration -- --nocapture --test-threads=1
```

Review platform-specific crates when shared behavior, geometry, native
windows, or platform integrations change.

### IPC binding changes

```sh
pnpm gen:bindings          # regenerates via scripts/bindings.sh
bash scripts/check-bindings.sh
```

### Repository-wide and CI changes

```sh
pnpm exec prettier --check "**/*.{ts,tsx,md}"   # verify mode; the root `pnpm format` script runs --write and mutates files
pnpm lint          # turbo run lint
pnpm check-types   # turbo run check-types
pnpm test          # turbo run test
```

Secret scanning is configured through `gitleaks.toml`; verify secrets with the
configured scanner rather than assuming a package script exists.

For workflow changes, inspect:

- Trigger events and path filters.
- Job permissions.
- Secret exposure.
- Cache keys.
- Required operating systems.
- Build inputs omitted from path filters.
- Symmetry of test coverage across supported platforms.

### Verification status

Use one of these states for each required check:

- **Passed**: the command completed successfully for the reviewed head SHA.
- **Failed**: the command completed unsuccessfully for the reviewed head SHA.
- **Not run**: the command was required but was not executed.
- **Not applicable**: the change cannot affect this check.
- **Inconclusive**: execution or output did not establish the result.

Record verification in this table:

| Check               | Applies when                               | Status                                         | Evidence                   |
| ------------------- | ------------------------------------------ | ---------------------------------------------- | -------------------------- |
| Formatting          | Source, docs, or configuration changes     | Passed / Failed / Not run / N/A / Inconclusive | Exact command and head SHA |
| Type check          | TypeScript contract changes                | …                                              | Exact command and head SHA |
| Clippy              | Rust changes                               | …                                              | Exact command and head SHA |
| Unit tests          | Changed deterministic logic                | …                                              | Exact command and scope    |
| Integration tests   | IPC, files, persistence, module boundaries | …                                              | Exact command and scope    |
| Desktop E2E         | Critical desktop contract                  | …                                              | Platform and scenario      |
| Bindings check      | Command or IPC changes                     | …                                              | `check-bindings.sh` result |
| Workflow inspection | Workflow or release changes                | …                                              | Reviewed workflow paths    |
| Security review     | Critical or High risk boundary             | …                                              | Threat-model record        |

Do not label CI as passing when required checks are pending, unavailable, or
inconclusive. A review with required `Not run` or `Inconclusive` verification
is **Needs Verification**, not **Ready**.

---

## 10. Phase 7: Finding Validation and Severity

A candidate finding requires all five conditions:

1. **Diff cause:** The pull request introduces the defect, changes its
   reachability, or blocks its safe repair.
2. **Reachable scenario:** A concrete input, state, event sequence, or platform
   condition reaches the defect.
3. **Concrete impact:** The resulting correctness, security, data, lifecycle,
   performance, or user impact is concrete.
4. **Minimal remediation:** A safe, minimal change can preserve the intended
   contract.
5. **Verification path:** A test, scenario, or command can prove the fix.

Discard the candidate if one condition is absent.

Use these severities:

| Severity | Meaning                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Exploitable authority or security boundary failure, data loss, widespread startup failure, or release-blocking defect                                                 |
| High     | Common correctness failure or crash, persistent corruption, core-flow failure, unsafe recovery, serious resource leak, or security defect with realistic reachability |
| Medium   | Reachable defect with bounded impact, incomplete recovery or error handling, or important missing behavior                                                            |
| Low      | Concrete uncommon defect or defensive gap with limited impact                                                                                                         |
| Nitpick  | No meaningful runtime or operational impact                                                                                                                           |

Use one finding per root cause. Do not split one defect into many comments.
Do not combine unrelated defects into one finding.
Do not report a finding only because an implementation differs from a
preferred pattern.

---

## 11. Review Report Format

Use this exact order.

```md
## Verdict

**Status:** Ready | Not Ready | Needs Verification
**Confidence:** High | Medium | Low
**Mergeable:** Yes | No | Unknown
**CI verification:** Passing | Failing | Pending | Inconclusive

## Change inventory

| Area | Changed contract | Risk | Required verification | Result |
| ---- | ---------------- | ---- | --------------------- | ------ |

## Findings

### [Critical|High|Medium|Low] Title

**Location:** `path/to/file.ext`, Line N
**Diff cause:** [What this pull request changed.]
**Evidence:** [Code trace, test result, CI output, or reproduction.]
**Reachable scenario:** [Input, persisted state, event sequence, or platform.]
**Impact:** [Concrete consequence.]
**Required change:** [Minimal safe remediation.]
**Verification:** [Specific test, scenario, or command.]

## Missing test coverage

- [Changed contract]: [smallest test that proves it].

## Verification performed

| Check | Status | Evidence |
| ----- | ------ | -------- |

## Correct behavior confirmed

- [Contract]: [Evidence and scope.]

## Assumptions and unknowns

- [What could not be verified and why.]
```

If no findings remain, state: `No validated findings.`
Do not add empty severity or finding sections.
Do not list an assumption as a finding.

---

## 12. Completion Rules

A review is **Ready** only when:

- No unresolved Critical, High, or Medium findings remain.
- Every Critical and High risk changed contract has direct evidence or a
  documented, justified indirect evidence path.
- Required verification is Passed or explicitly Not applicable.
- Generated bindings and artifacts match their source of truth.
- Required boundary traces are complete.
- The report distinguishes verified facts from assumptions and unknowns.

A review is **Needs Verification** when code analysis is complete but required
execution evidence is pending, unavailable, or inconclusive.

A review is **Not Ready** when a validated finding blocks safe merge.

Confidence measures evidence quality, not reviewer certainty. A reviewer must
not claim high confidence without completing every relevant verification step.

| Confidence | Meaning                                                                           |
| ---------- | --------------------------------------------------------------------------------- |
| High       | Required traces and verification are complete.                                    |
| Medium     | Code analysis is complete, but limited verification or platform coverage remains. |
| Low        | Important inputs, traces, or verification are unavailable.                        |

---

## 12.1 Fast Path: Low-Risk, Documentation-Only Changes

When every inventory record is Low risk and no changed file affects an
operational contract (no code, tests, workflows, manifests, lockfiles,
configuration, generated output, or documented commands), the review may use
this minimum form. If any record exceeds Low risk, run the full procedure.

Required steps:

1. Read the complete diff.
2. Confirm the change inventory contains only Low risk records, and record
   why (for example: prose-only edits under `apps/docs/src/content/docs/`).
3. Check that changed prose does not alter a documented command, path,
   contract, or security statement. A docs change that edits an operational
   instruction is not docs-only — reclassify it and run the full procedure.
4. Run the relevant formatting check (`pnpm exec prettier --check` on the
   changed files) or record why it is not applicable.

Minimum report:

```md
## Verdict

**Status:** Ready | Not Ready
**Confidence:** High | Medium | Low
**Mergeable:** Yes | No | Unknown
**CI verification:** Passing | Failing | Pending | Inconclusive

## Change inventory

One line per file: path, "docs-only", Low, and the reason.

## Findings

`No validated findings.` or the standard finding format.

## Verification performed

| Check      | Status                          | Evidence                   |
| ---------- | ------------------------------- | -------------------------- |
| Formatting | Passed / Failed / Not run / N/A | Exact command and head SHA |
```

The fast path never applies to changes touching `AGENTS.md`, `REVIEW.md`,
this file, Tauri configuration, capabilities, workflows, or anything listed
Critical or High in Section 3.2.

---

# Part II — Project Risk Catalog

Use this catalog only after Phase 0 selects a relevant module. These checks
distill the architectural contracts, security boundaries, and recurring
findings raised across historical mausVoice PRs by automated reviewers for the
Rust (Tauri) backend and the React/TypeScript frontend. A catalog match is a
review prompt, not a finding — apply the Phase 7 validation gate to anything
it surfaces.

## 13. Rust (Tauri) Backend

### 13.1 Subprocess management

**Traps:** `wait_with_output()` buffers unbounded stdout/stderr into RAM (OOM);
timing out without `kill()` + `wait()` leaks zombies; not draining pipes
concurrently deadlocks a chatty child on a full pipe buffer; `Command::new`
cannot run CMD builtins (`dir`, `echo`, `ver`) — only real executables.

**Pattern:** drain stdout _and_ stderr on background threads with an explicit
byte cap (keep draining past the cap), keep the `Child` handle and kill+reap
on timeout (don't unconditionally join readers afterwards — descendants may
hold the pipe), and allow-list genuine binaries only.

### 13.2 File I/O, paths, symlinks

**Traps:** validating a relative path against `audio_dir` but passing the
_raw_ input to `remove_file` resolves against CWD; `.starts_with(audio_dir)`
is lexical and loses to `..` and symlinks; an un-canonicalized `audio_dir`
makes every comparison fail silently.

**Pattern:** canonicalize both the file's parent and the target directory
before comparing; reject symlinks at the final component via
`symlink_metadata` (but allow not-yet-existing destinations); always
delete/operate on the canonical `PathBuf` your validator returns, never the
raw string.

### 13.3 Network streaming & redirects

**Traps:** default redirect policies follow untrusted hosts; trusting
`Content-Length`; unbounded writes to disk.

**Pattern:** a custom `redirect::Policy` validating host/scheme and capping
hops; reject oversized advertised lengths up front; enforce the cap again with
a per-chunk byte counter and delete the partial file on breach. Treat a
missing `Content-Length` as a policy choice — require it for fixed artifacts
from hosts you control, allow `None` where chunked/compressed responses are
legitimate.

### 13.4 Concurrency & test integrity

**Traps:** a process-global `CANCEL_TYPING` flag with no session key lets
session A's late cancel abort session B; cargo runs tests in parallel threads,
so writing shared statics randomly fails other tests.

**Pattern:** key cancellation to a session and no-op outside an active one; in
tests, wrap global access in helpers and restore prior values with a `Drop`
guard.

### 13.5 SQLite & migrations

**Traps:** tautological table assertions (a hardcoded list vs. its copy) let a
new table escape the privacy wipe; per-table deletes without a transaction
leave partial wipes.

**Pattern:** tests read the live schema (`sqlite_master`), subtract an
explicit allow-list (`sqlite_%`, `_sqlx_migrations`), and assert every
remaining table is in `USER_DATA_TABLES_TO_CLEAR`; wrap wipes in
`pool.begin()`.

**Migration recovery checks** (apply when database opening, migration, schema,
integrity, or recovery changes):

- Apply related migration steps atomically where partial application is unsafe.
- Detect a failed prior migration before treating the database as valid.
- Detect changed migration content with independently verified checksums.
- Preserve the original database before quarantine or replacement.
- Preserve or move relevant `-wal` and `-shm` sidecars with the database.
- Do not quarantine a database for unrelated transient connection failures.
- Explicitly roll back a failed transaction where the library does not provide
  the required rollback guarantee.
- Test fresh creation, valid upgrade, failed migration, checksum mismatch,
  corruption, quarantine, and non-integrity failure.
- Confirm the app setup owns the startup recovery decision.
- Confirm a recovered startup does not silently erase diagnostic evidence.

### 13.6 IPC, CORS, CSP

Keep `remote.urls` restricted to localhost loopbacks — wildcards give any
loaded page (docs mirrors included) native command access. External domains
stay IPC-free webviews. Keep CSP in `tauri.conf.json` synchronized with
production (`script-src 'self'`), and scrub stale comments claiming IPC access
the config no longer grants.

When commands or IPC contracts change:

- Trace the Rust command to registration in `app.rs`.
- Trace the command to its TypeScript binding and caller.
- Regenerate bindings through `scripts/bindings.sh` or the documented cargo
  build path; never hand-edit generated bindings.
- Validate externally controllable fields at the Rust boundary.
- Check safe integer and binary-data behavior across Rust and JavaScript.
- Test success, malformed payload, authorization, and error serialization.

### 13.7 Native pills & window geometry

Offset toplevel coordinates by half the window width/height so Linux/X11 drags
match macOS and Windows center anchoring (raw origins make the pill jump
monitors). Use inclusive boundary probes and place fallbacks strictly inside
the screen (e.g. `max - 1.0`) so the pill never lands off-screen.

### 13.8 Model cache contention

Holding `MODEL_CACHE.lock()` across a whole inference serializes every
transcription. **Acquire, clone the runtime handle, `drop(cache)`**, then run
the heavy computation unlocked.

### 13.9 ONNX auxiliary artifacts

Never `let _ = tokio::spawn(...)` companion downloads (tokenizers, vocabs,
configs) — dropped join handles hide failures and leave models silently
half-installed. Aggregate the artifact futures and `tokio::try_join!` them
before reporting ready. In tests, poll readiness instead of sleeping a fixed
duration.

## 14. TypeScript & React Frontend

### 14.1 Hooks & StrictMode

Never assign `ref.current` or set state during render — StrictMode's double
render corrupts it. A ref-guarded controller built once
(`if (!ref.current) ref.current = new Controller(options)`) freezes later
`options` (e.g. `timeoutMs`). Do setup in `useEffect`, and pass dynamic config
as call arguments (`controller.run(promise, timeoutMs)`).

### 14.2 Async state & races

Two overlapping reloads can let the older response overwrite newer data; state
set after unmount leaks. Use a **monotonic generation counter** in an async
controller — increment on each `run()`, and bail out of every completion,
error, timeout, and cleanup path whose generation no longer matches. Return a
teardown from `useEffect` that increments the generation and clears timers.

### 14.3 IPC bindings

Never hand-edit `bindings.ts` — regenerate via `scripts/bindings.sh` or the
cargo build flow after changing `commands.rs`, and register every new command
in the builder in `app.rs`.

### 14.4 Audio input safety

Close/pause microphone streams in `useEffect` cleanup or the OS recording
indicator stays lit and handles leak. Iterate `Float32Array` PCM with built-in
array methods or explicit range guards, never unchecked C-style indexing.

### 14.5 Default device drop-off

If the default device's display name fails to resolve, fall back to a
placeholder like `"System Default"` — returning `None` strips `is_default`
and the UI shows no default mic. Cache and target devices by stable hardware
ID instead of re-enumerating by label on every recording toggle.

### 14.6 Browser events and error overlay

When React lifecycle, global listeners, startup assets, or fatal overlay
behavior changes:

- Do not create persistent side effects during render.
- Remove global listeners when their startup-only responsibility ends.
- Classify resource-load failures separately from runtime errors.
- Treat mounted and pre-mount failure behavior as separate contracts.
- Do not let a non-fatal post-mount error hide a usable application.
- Preserve logging for ignored non-fatal errors when diagnostics require it.
- Test scripts, stylesheets, images, runtime errors, unhandled rejections, and
  mount state separately.

## 15. CI/CD & Monorepo

- **15.1 Turbo graph:** `"check-types": { "dependsOn": ["^check-types"] }`
  yields spurious `TS2307` because dependencies were never built. Depend on
  `["^build"]`.
- **15.2 Least privilege:** verification jobs (format, lint, typecheck, cargo
  test) get `permissions: contents: read`; write scopes only in
  publish/release steps.
- **15.3 Trigger filters:** desktop `paths` filters must cover everything
  affecting compilation — `apps/desktop/**`, `packages/**`, `patches/**`,
  `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`,
  `.nvmrc`, `.github/scripts/install-desktop-linux-deps.sh`.
- **15.4 Dependency floors:** keep both bounds in overrides —
  `"vitest@<3.2.6": ">=3.2.6 <4.0.0"`. Dropping the floor permits a downgrade
  back into vulnerable `3.x`.
- **15.5 Updater trust anchors:** never commit signing keys or
  `__UPDATER_PUBLIC_KEY__` literals (a fork could sign binaries the app
  auto-trusts), and never duplicate the literal across CI and setup scripts.
  Set `"createUpdaterArtifacts": false` publicly and inject
  `TAURI_UPDATER_PUBLIC_KEY` from repository secrets during the release build
  only.
- **15.6 Platform symmetry:** if `rust_windows_pill` gets `cargo test`, so
  must `rust_macos_pill` and `rust_gtk_pill` — clippy-only coverage hides
  runtime bugs. Provision tools (e.g. `imagemagick`) in the platform
  dependency scripts, not loose inline installs without `apt-get update`.
  When a shared contract changes, verify every affected platform crate; do not
  treat Clippy-only coverage as runtime verification.
- **15.7 Boolean casts:** `"false"` is truthy in Node and Python, so
  `CI=false` reads as "in CI". Compare explicitly:
  `process.env.CI === "true"`.

## 16. Suggestions & Nitpicks

**Suggestions** (`🟡 Minor` / `🔵 Trivial`) — performance, maintainability,
defensive coding: strip dead variables, imports, and ignored parameters;
prefer safe option handling (`unwrap_or_default()`, `if let Some`, `?.`, `??`)
over risky unwraps; adopt modern idioms (`std::mem::take`, iterator
combinators over C-style loops; `async/await` over `.then` chains); avoid
holding a mutex across a nested call that causes micro-contention and render
delay.

**Nitpicks** — zero functional impact: formatting drift and stray/trailing
whitespace, missing trailing newline at EOF, comments that contradict the code
they describe (e.g. "throws X" after a rewrite to `Result`), and descriptive
renames following monorepo casing (camelCase TS, snake_case Rust).

**Linter boundaries:** **Oxlint** scans `apps/desktop/src` per
`apps/desktop/oxlint.json` via `pnpm --filter desktop run lint` (which also
runs a Prettier check); **Prettier** covers TS/TSX, CSS, and Markdown through
the root `format` script; **Clippy** runs `cargo clippy -- -D warnings` for
the Tauri backend and each native pill crate. There is **no ESLint or
Markdownlint in CI** — Markdown structure findings are readability nits, not
gates. Verify proposed suggestions don't themselves break these checks.

## 17. Anti-Pattern Checklist

| Category         | Smell / Anti-Pattern                 | Severity | Remediation                                     |
| :--------------- | :----------------------------------- | :------- | :---------------------------------------------- |
| Rust Security    | Raw string path deletions            | Critical | Canonicalize; act on the returned `PathBuf`     |
| Rust Security    | Unvalidated HTTP redirects           | Critical | Custom policy verifying host, scheme, hop count |
| Rust Security    | Over-permissive `remote.urls`        | Critical | Restrict IPC capability to loopback             |
| CI Security      | Committed updater keys               | Critical | Inject from secrets at release time             |
| Rust Performance | Buffering subprocess output in RAM   | Major    | Stream via capped concurrent readers            |
| Rust Concurrency | Parallel tests mutating statics      | Major    | Scope access; restore in a `Drop` guard         |
| Rust Concurrency | Mutex held across long async work    | Major    | Clone under a short lock, drop, then run        |
| Rust Robustness  | Tautological constant tests          | Major    | Parse the live schema in tests                  |
| Rust Operations  | Fire-and-forget companion spawns     | Major    | Aggregate and await the full artifact set       |
| React Hooks      | Writing refs during render           | Major    | Move into `useEffect` or pure setters           |
| React Safety     | Stale cached controllers/config      | Major    | Pass dynamic params per call                    |
| CI Coverage      | Asymmetrical per-platform tests      | Major    | Symmetrical `cargo test` on all targets         |
| Rust UI          | Exclusive max bounds in geometry     | Medium   | Place strictly within screen bounds             |
| React Lifecycle  | State set after unmount              | Medium   | Generation counter discards stale updates       |
| TS Hardware      | Default input dropped on label scan  | Medium   | Placeholder label for unnamed defaults          |
| CI / CD          | Over-privileged `GITHUB_TOKEN`       | Medium   | `contents: read` on verification jobs           |
| Turborepo        | Tautological task dependencies       | Medium   | Depend on `^build`                              |
| Script Safety    | Env vars cast to boolean             | Medium   | Explicit string comparison                      |
| TS Performance   | Label lookups each hardware cycle    | Minor    | Target cached, stable device IDs                |
| Clean Code       | Dead variables and imports           | Minor    | Strip for a clean Oxlint pass                   |
| Formatting       | Missing heading blanks / EOF newline | Nitpick  | Normalize Markdown formatting                   |
| Documentation    | Comments contradicting signatures    | Nitpick  | Rewrite docs to match the code                  |

---

# Part III — Operational Changes and Automation Backlog

## 18. Recommended Operational Changes

- Keep the detailed historical traps only under the **Project Risk Catalog**
  (Part II). A procedure specifies required actions; it does not simulate a
  reviewer personality.
- Add a PR template checkbox for the change inventory and required
  verification. The template should require:
  - User-visible change summary.
  - Persisted-data or compatibility effect.
  - Security boundary effect.
  - Required verification and platform coverage.
  - Manual E2E scenario when a desktop-runtime contract changes.
  - Rollback or recovery behavior when startup, migration, or release
    behavior changes.
- Make CI publish the exact commands it runs. The review should cite those
  results instead of assuming that `cargo test` or `pnpm test` covers every
  workspace.
- Require regression tests for each confirmed correctness defect. This
  prevents a fixed symptom from returning through another code path.

## 19. Review Automation Backlog

The repository should eventually automate the repeatable evidence collection.

A review-inventory script should report:

- Base SHA and head SHA.
- Changed files, renamed files, deleted files, and binary files.
- Changed Rust public functions, `tauri::command` declarations, and command
  registrations.
- Changed TypeScript exports, hooks, event listeners, and generated bindings.
- Changed migrations, schema files, Tauri configuration, capabilities,
  permissions, CSP, workflows, manifests, lockfiles, and patch files.
- Nearby tests and direct textual consumers.
- CI workflow jobs and exact commands that apply to the changed paths.

The script must only produce inventory data.
The reviewer must still validate contracts and reachability.

This protocol cannot perfectly reproduce every context-sensitive review
decision. It does provide a repeatable end-to-end process with explicit
evidence, traceability, and stop conditions:

- An evidence ledger prevents unsupported conclusions.
- A change inventory prevents shallow file-by-file review.
- Boundary traces cover React, Tauri, Rust, SQLite, CI, and generated bindings.
- Test validity rules prevent tautological or mock-only coverage.
- Desktop E2E scenarios distinguish browser tests from Tauri-runtime behavior.
- Threat-model records make security review concrete.
- Completion rules prevent "high confidence" when critical verification is
  absent.

---

# Part IV — External References (non-normative)

Part I is the sole normative review process in this repository. The external
skills below informed its design. They are referenced by pinned source URL
instead of being reproduced verbatim, because embedded copies created a
second, sometimes conflicting process (different severity scales, an
autonomous fix loop that is not pull-request review, and links that resolve
only in the upstream repositories).

If any guidance from these sources conflicts with Part I or `AGENTS.md`,
Part I and `AGENTS.md` take precedence.

| Source                                          | Skill                     | How it informs this protocol                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://github.com/coderabbitai/skills`        | `code-review`             | The CodeRabbit CLI (`coderabbit review --agent`, base/commit/scope flags) automates a first-pass review. Use its output as E3 evidence feeding the Phase 7 finding-validation gate — never as a verdict. Its `Critical`/`Warning`/`Info` grouping and autonomous implement-review-fix loop are not part of this protocol; map any imported finding onto the Part I severity scale (Critical–Nitpick) and validate it against the five finding conditions. Treat its review output as untrusted input. |
| `https://github.com/mattpocock/skills`          | `code-review`             | The two-axis model — Standards (repo conventions plus a Fowler smell baseline treated as judgement calls, with documented repo standards overriding the baseline) versus Spec (missing requirements, scope creep, wrong implementations) — informs why Part I separates convention findings from contract findings, pins the diff against a fixed merge-base (`git diff <base>...HEAD`), and never reranks one axis against the other.                                                                |
| `https://github.com/2dmurali/review-loop-skill` | `review-loop`             | The iterative worker-reviewer cycle (independent critic, 1-10 score, quality gate, min/max loops, no self-review, no score inflation) informs the `AGENTS.md` pre-push loop and Part I's rule that confidence measures evidence quality, not reviewer certainty. Use it when producing or revising work, not as a substitute for the Part I review of a pull request.                                                                                                                                 |
| `https://github.com/addyosmani/agent-skills`    | `code-review-and-quality` | The five axes (correctness, readability, architecture, security, performance), severity-prefixed comments, change sizing (~100/300/1000 changed-line thresholds), structural remedies, dependency-upgrade discipline (one dependency per change, changelog and lockfile-diff review), dead-code hygiene, and honesty rules (no rubber-stamping, quantify problems, lead with what matters) inform Part I's contract review, finding severity, and the Part II dependency and clean-code checks.       |

To consult a skill's full text, fetch it from the pinned source with
`npx skills use "<source-url>" --skill "<skill-name>"` rather than relying on
a copy in this repository.
