# mausVoice Expert Agent Review & Hardening Handbook

This handbook serves as a comprehensive, deep-dive reference guide for AI development agents and engineers working on the `mausVoice` repository. It synthesizes architectural patterns, system vulnerabilities, critical code smells, and validation gaps discovered across all historical pull requests—with a particular focus on the automated audits, static analysis, and regression findings raised by CodeRabbit, Kilo Code, and other automated reviewers.

Use this guide to proactively audit your own code changes, prevent regressions in security or privacy boundaries, and understand the rigorous design contracts governing both the Rust (Tauri) backend and the React (TypeScript) frontend.

---

## Table of Contents
1. [CodeRabbit & Kilo Code Review Personas & Analytical Behaviors](#1-coderabbit--kilo-code-review-personas--analytical-behaviors)
    - [1.1 CodeRabbit Persona and Assertive Audit Posture](#11-coderabbit-persona-and-assertive-audit-posture)
    - [1.2 CodeRabbit Relational Dynamics and Suggestion Patterns](#12-coderabbit-relational-dynamics-and-suggestion-patterns)
    - [1.3 Kilo Code (kilocode-bot) Precision-Review Behavior](#13-kilo-code-kilocode-bot-precision-review-behavior)
2. [The Hardened Pre-Release Production Audit Protocol](#2-the-hardened-pre-release-production-audit-protocol)
    - [2.1 Scope & Verification Contract](#21-scope--verification-contract)
    - [2.2 Mandatory Self-Review Pass (Cause, Action, Reaction, Necessity)](#22-mandatory-self-review-pass-cause-action-reaction-necessity)
    - [2.3 Required Verdict Format](#23-required-verdict-format)
    - [2.4 Expanded Coverage Checklist](#24-expanded-coverage-checklist)
    - [2.5 Required Report Structure](#25-required-report-structure)
3. [Rust (Tauri) Backend Hardening & Deep Dive Categories](#3-rust-tauri-backend-hardening--deep-dive-categories)
    - [3.1 Subprocess Management & Shell Execution](#31-subprocess-management--shell-execution)
    - [3.2 File I/O, Path Normalization, and Symlink Attacks](#32-file-io-path-normalization-and-symlink-attacks)
    - [3.3 Secure Network Streaming & Redirect Validation](#33-secure-network-streaming--redirect-validation)
    - [3.4 Concurrency Controls, Global Atomic Flags, and Parallel Test Integrity](#34-concurrency-controls-global-atomic-flags-and-parallel-test-integrity)
    - [3.5 SQLite & Migration Parsing Integrity](#35-sqlite--migration-parsing-integrity)
    - [3.6 Tauri IPC Bridge, CORS, and CSP Policies](#36-tauri-ipc-bridge-cors-and-csp-policies)
    - [3.7 Desktop-Native Pills & Multi-Platform Window Geometry](#37-desktop-native-pills--multi-platform-window-geometry)
    - [3.8 Global Model Cache Serialization & Resource Contention](#38-global-model-cache-serialization--resource-contention)
    - [3.9 ONNX Auxiliary Artifact Download Lifecycle](#39-onnx-auxiliary-artifact-download-lifecycle)
4. [TypeScript & React Frontend Lifecycle Contracts](#4-typescript--react-frontend-lifecycle-contracts)
    - [4.1 React Hooks & StrictMode Compliance](#41-react-hooks--strictmode-compliance)
    - [4.2 Safe Async State Transitions & Race Conditions](#42-safe-async-state-transitions--race-conditions)
    - [4.3 IPC Protocol Integration & Binding Alignment](#43-ipc-protocol-integration--binding-alignment)
    - [4.4 Audio Input and Pulse Recording Safety](#44-audio-input-and-pulse-recording-safety)
    - [4.5 Host Default Device Drop-off during Cache Enumeration](#45-host-default-device-drop-off-during-cache-enumeration)
5. [CI/CD & Monorepo Dependency Orchestration](#5-cicd--monorepo-dependency-orchestration)
    - [5.1 Turborepo Task Graph Dependency Integrity](#51-turborepo-task-graph-dependency-integrity)
    - [5.2 Minimal-Privilege Workflow Scopes](#52-minimal-privilege-workflow-scopes)
    - [5.3 Exact Monorepo Trigger Filters](#53-exact-monorepo-trigger-filters)
    - [5.4 Hardened Package Resolution & Dependency Floors](#54-hardened-package-resolution--dependency-floors)
    - [5.5 Committed Secrets & Updater Public Key Trust Anchors](#55-committed-secrets--updater-public-key-trust-anchors)
    - [5.6 Multi-Platform Workflows and Test Execution Gaps](#56-multi-platform-workflows-and-test-execution-gaps)
    - [5.7 Shell Context Evaluation and Boolean Cast Assumptions](#57-shell-context-evaluation-and-boolean-cast-assumptions)
6. [The Definitive Suggestions & Nitpicks Guide](#6-the-definitive-suggestions--nitpicks-guide)
    - [6.1 Suggestion Typology: Quality-of-Life, Defensive Coding, and Scalability](#61-suggestion-typology-quality-of-life-defensive-coding-and-scalability)
    - [6.2 Nitpick Typology: Linters, Spacing, and Non-Functional Semantics](#62-nitpick-typology-linters-spacing-and-non-functional-semantics)
    - [6.3 Code Quality & Linter Boundaries (Oxlint, Prettier, Markdownlint)](#63-code-quality--linter-boundaries-oxlint-prettier-markdownlint)
7. [Universal Code Smell & Anti-Pattern Detection Checklist](#7-universal-code-smell--anti-pattern-detection-checklist)

---

## 1. CodeRabbit & Kilo Code Review Personas & Analytical Behaviors

Automated code review bots are highly specialized and use distinct personas when parsing code. Understanding their analytical behavior, how they construct reviews, and their relational dynamics allows development agents to write code that passes automated checks on the first attempt.

### 1.1 CodeRabbit Persona and Assertive Audit Posture

CodeRabbit is configured with an **Assertive Audit Posture**. This profile focuses on functional correctness, security vulnerabilities, edge-case validation, memory leaks, and concurrency bugs, while deprioritizing superficial style discussions unless they point to deeper systemic flaws.

#### Key Persona Traits:
*   **Context-Aware Static Analysis:** CodeRabbit does not inspect files in isolation. It parses the entire pull request, maps data flow across the workspace (e.g., from frontend user inputs through React hooks to Tauri's IPC layer and down to SQLite or system level APIs), and references historical learnings captured in metadata files.
*   **Assertion on Functional Correctness:** CodeRabbit assumes that if an edge case is physically possible, a user or external input will eventually trigger it. It systematically checks for missing bounds validation, buffer sizes, unhandled network failures, and race conditions.
*   **Incremental Code Investigation:** When a pull request is created or a review is invoked via `@coderabbitai review`, CodeRabbit executes analysis chains using AST matching (e.g., `ast-grep`) and regex scanning (`rg`) to trace symbol definitions and compare execution flow changes with the main branch.

---

### 1.2 CodeRabbit Relational Dynamics and Suggestion Patterns

CodeRabbit's review comments follow a standardized structural hierarchy designed to help human developers and AI coding agents quickly assess, understand, and apply suggestions.

#### Anatomy of a CodeRabbit Finding:
1.  **Severity Classification:**
    *   `🔴 Critical / Blocker`: Represents severe vulnerabilities (e.g., arbitrary file write, shell injection, authentication bypass) or immediate runtime crash vectors.
    *   `🟠 Major`: Denotes functional bugs, resource leaks (OOM, file descriptor exhaustion), concurrency races, or unhandled promise rejections.
    *   `🟡 Minor / Suggestion`: Focuses on optimization, modern language idioms, clean architecture, or documentation/comment contradictions.
2.  **Contextual Analysis:** CodeRabbit explicitly states *why* the code is problematic, citing concrete paths, line numbers, and the precise mechanical sequence that leads to the failure.
3.  **Committable Diff Suggestion:** High-quality findings always include a committable diff block with precise line offsets and clean spacing, allowing developers to apply the fix with a single click.
4.  **Prompt for AI Agents:** Every finding ends with an instruction block wrapped in a `<details>` element containing a targeted prompt for AI agents. This prompt specifies the exact target file, line boundaries, and minimal fix constraints to guide downstream LLMs in fixing the issue without causing collateral drift.

---

### 1.3 Kilo Code (kilocode-bot) Precision-Review Behavior

Kilo Code works as an assertive correctness reviewer with a specialized focus on security boundaries, regressions, and semantic inconsistencies. It monitors commits for security guard regressions, such as replacing robust canonicalization helpers with lexical string comparisons.

#### Analytical Strategy of Kilo Code:
*   **Contract Enforcement:** Kilo Code strictly evaluates if the code lives up to its own written comments and contracts. For example, if a doc comment claims "traversal cannot escape the managed directory," Kilo Code will immediately audit the source to see if standard `std::fs::canonicalize` or robust parent containment filters are in place. If there is a discrepancy between the comment and the code, Kilo Code flags it as a high-priority bug.
*   **Tautological Test Detection:** Kilo Code flags testing strategies that assert a hardcoded constant against itself (e.g., asserting a hardcoded table list matches a hardcoded constant list). It demands that tests extract system schema dynamically to verify actual runtime properties.
*   **Resource Leak Tracking:** It meticulously monitors system resources, demanding immediate release of file handles, termination of background workers, and explicit error logging instead of silently ignoring promise rejections.

---

## 2. The Hardened Pre-Release Production Audit Protocol

This section defines the formal audit protocol that agents and engineers must execute before proposing, merging, or releasing code in the `mausVoice` repository.

### 2.1 Scope & Verification Contract

A pre-release audit must target the **FULL diff** of the pull request against the target release branch, not just the headline files or modified files. Every single change must be verified against its complete dependency chain, tracing from user interaction layers down to deep filesystem persistence and hardware streams.

---

### 2.2 Mandatory Self-Review Pass (Cause, Action, Reaction, Necessity)

Before proposing any fix or creating a review finding, agents must run the candidate change through a rigid **four-step validation gate**. If the change fails to survive all four checks, it is discarded immediately.

```
       [Candidate Audit Finding / Change]
                       │
                       ▼
    ┌─────────────────────────────────────┐
    │ 1. CAUSE:                           │
    │ Is the root cause in THIS diff, or  │
    │ is it pre-existing on base branch?  │
    └──────────────────┬──────────────────┘
                       │ Survives
                       ▼
    ┌─────────────────────────────────────┐
    │ 2. ACTION:                          │
    │ Does the proposed fix compile &     │
    │ perfectly match project types/convs?│
    └──────────────────┬──────────────────┘
                       │ Survives
                       ▼
    ┌─────────────────────────────────────┐
    │ 3. REACTION:                        │
    │ Trace all call sites. Does the fix  │
    │ break consumers or create new bugs? │
    └──────────────────┬──────────────────┘
                       │ Survives
                       ▼
    ┌─────────────────────────────────────┐
    │ 4. NECESSITY:                       │
    │ Is this a real bug/vulnerability,   │
    │ or merely a style/format opinion?   │
    └──────────────────┬──────────────────┘
                       │ Survives
                       ▼
       [Approved Finding / Committable Diff]
```

#### Detailed Gate Definitions:
1.  **Cause:** What is the actual root cause? Is the issue introduced by the new code in this PR, or is it pre-existing on the target branch? Avoid attributing legacy base defects to current PR authors unless they directly compound the regression.
2.  **Action:** Is the proposed fix correct by construction? Does it compile? Does it match the established idioms, patterns, and typescript/rust type signatures of the workspace? Hand-written, untested refactor suggestions that fail syntax checks are strictly prohibited.
3.  **Reaction:** What breaks if the fix is applied? Trace every call site, consumer hook, and sidecar script. Does your proposed change introduce subtle race conditions, lock contention, test failures, or linter errors in CI?
4.  **Necessity:** Is this a genuine correctness bug, security risk, or performance blocker? If it is a style preference, does the "fix" risk introducing regression vectors? Prioritize robust system stability over subjective code styles.

---

### 2.3 Required Verdict Format

Every pre-release production audit must conclude with a clear, unambiguous verdict declaration:

`## Verdict: **Ready**` or `## Verdict: **Not Ready**`

#### Verdict Requirements:
*   Must specify audit confidence level: `Confidence: **[High/Medium/Low]**`.
*   Must state branch mergeability: `Mergeable: **[Yes/No]**`.
*   Must detail CI verification state: `CI Verification: **[Passing/Failing/Pending]**`.

---

### 2.4 Expanded Coverage Checklist

Audit reviews must explicitly trace and check every single one of the following ten architectural vectors. **Do not omit any item.**

1.  **Merge State:** Verify branch mergeability. Identify any active conflicts with the target branch and assess if automated rebasing is safe.
2.  **IPC Boundary:** Review every single new or modified `ipcMain.handle`, `tauri::command`, or bridge routing hook. Check for:
    *   Strict payload type validation.
    *   Safe integer boundaries (e.g. converting `u64` parameters cleanly to avoid precision losses in standard JavaScript `Number`).
    *   Strict array/buffer bounds checking.
    *   Discriminated Union result types to handle execution errors without throwing unhandled exceptions.
3.  **State Machine / Lifecycle:** Audit all asynchronous execution scopes, ensuring:
    *   Unconditional cancellation of active actions on component unmount or transition.
    *   Rejection of stale async callbacks using monotonic generation counters or cancellation tokens.
    *   Re-entrancy guards on serial operations (like simulated keystroke streams).
    *   Immediate release of all system resources, event handles, or hardware streams upon component teardown.
4.  **Persistence:** Audit all localStorage, app-config, and SQLite database writes. Check for:
    *   Single Source of Truth (SSOT) enforcement—no dual-write paths that can drift.
    *   Migration safety and schema coverage.
    *   Database transaction rollbacks (`ROLLBACK`) on intermediate sequence failures.
5.  **UI Logic:** Ensure frontend safety on:
    *   Fully controlled React inputs (no uncontrolled-to-controlled transitions).
    *   Exhaustive effect dependency arrays in `useEffect`, `useCallback`, and `useMemo` hooks.
    *   Explicit teardown of DOM/window event listeners.
    *   Explicit pending, disabled, loading, empty, and error fallback UI states.
6.  **UI Review & Visual Consistency:** Evaluate:
    *   **Visual Hierarchy & Spacing:** Perfect padding, margins, and layout alignments on a standard grid.
    *   **WCAG AA Contrast & Typography:** Clear font weights, scaling, and contrast ratios on light/dark mode transitions.
    *   **Focus & Keyboard Navigation:** Complete tab-navigation focus rings, trapping focus within modals, and platform-specific keyboard shortcuts (e.g., `Cmd` on macOS vs. `Ctrl` on Windows/Linux).
    *   **Micro-interactions & Scoped Transitions:** No generic `transition: all` styles (which cause performance-heavy layout repaints and visual stuttering); transitions must be strictly scoped to specific properties (e.g. `transition: opacity 0.2s ease`).
    *   **Theme Continuity:** Seamless light/dark surface transitions with zero un-themed flash frames.
7.  **Edge Cases:** Audit code performance against:
    *   Empty arrays or zero-length payload buffers.
    *   Implicit `null` or `undefined` properties versus missing fields in loose JSON contexts.
    *   Platform-specific variations (such as folder hierarchies and carriage-return `\r\n` line breaks).
    *   Boundary data limits (e.g., processing transcription queries on empty/silent audio files, or zero-character typing prompts).
8.  **Security & Sandboxing:** Check for:
    *   URL protocol and scheme validation.
    *   Tauri scope boundaries (restricting command execution permissions).
    *   Directory traversal escapes (`../`) and canonicalization guards.
    *   XSS injection risks inside webviews.
9.  **Test Coverage:** Identify any gap in unit, integration, or E2E smoke tests. Highlight important new behaviors that are completely untested.
10. **Lint/CI Compliance:** Confirm compliance with all monorepo linters (`oxlint`, `eslint`, `prettier`, `clippy`). Ensure no new warning flags are introduced.

---

### 2.5 Required Report Structure

Audit results must conform strictly to the following five-section report hierarchy:

```markdown
## Verdict
[Ready/Not Ready Verdict + Confidence + Mergeability + CI Status]

## Major findings
- **[Severity — Brief Title]**  
  `File Path:Line Number`  
  *The Problem:* Clear description of the vulnerability or bug mechanism.  
  *The Solution:* Committable suggestion or remediation pattern.

## Minor findings
- **[Description]**  
  `File Path:Line Number`  
  *Context:* Analysis of the minor bug, optimization, or clean-code deviation.

## Nitpick findings
- **[Stylistic Suggestion]**  
  `File Path:Line Number`  
  *Context:* Formatting alignment, comment drift, or linter-level style suggestions.

## UI review findings
- **[UI Defect]**  
  `File Path:Line Number`  
  *Context:* Spacing, WCAG AA compliance, transitions, focus state, or dark/light theme defects.

## Missing important test coverage
- **[Untested Invariant]**  
  *Details:* Description of the unverified execution branch or boundary state.

## What is working correctly
- **[Verified Invariant]**  
  *Details:* Positive confirmation of hardened guards, clean state-transitions, or passing suites.
```

---

## 3. Rust (Tauri) Backend Hardening & Deep Dive Categories

### 3.1 Subprocess Management & Shell Execution

When launching commands or background processes in Rust using `std::process::Command`, there are several subtle but severe traps that can lead to memory exhaustion, process leaks, or dead code.

#### The Code Smells & Traps
1.  **Unbounded Output Buffering (`child.wait_with_output()`):**
    Calling `wait_with_output()` collects all data written to `stdout` and `stderr` directly into memory before any truncation or processing can happen. If a subprocess runs away or outputs gigabytes of logs, it will crash the desktop app with an Out-of-Memory (OOM) error.
2.  **Zombie and Leaked Subprocesses on Timeout:**
    Setting a timeout on a spawned command task but returning early without terminating the child leaves the subprocess running indefinitely. If the user invokes the command repeatedly, dozens of orphaned processes will pool in the background, consuming CPU and system resources.
3.  **Bypassing the Shell vs. Windows CMD Builtins:**
    Excluding a generic shell (like `sh` or `cmd.exe`) is standard practice to prevent shell-injection vulnerabilities. However, running CMD builtins like `dir`, `cd`, `echo`, or `ver` via `Command::new` directly in Windows will always fail with a `NotFound` error, as they are not standalone executables.

#### The Hardened Architectural Pattern
For safe command execution, you must:
*   Read `stdout` and `stderr` incrementally via separate threads/tasks with an explicit byte cap.
*   Retain a handle to the `Child` and explicitly terminate (`child.kill()`) and reap (`child.wait()`) it if a timeout is reached.
*   Only allow genuine compiled executables (like `whoami`, `where`, `hostname`, `explorer`) in the Windows allow-list, completely avoiding CMD builtins.

*Example Implementation:*
```rust
use std::process::{Command, Stdio, Child};
use std::time::Duration;
use std::io::Read;

pub fn execute_with_timeout(mut command: Command, timeout: Duration, max_bytes: usize) -> Result<Vec<u8>, String> {
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    
    // Spawn threads or read with an explicit limit to avoid OOM
    // Ensure that if the timeout expires, we kill the child process:
    match child.wait_timeout(timeout) {
        Ok(Some(status)) => {
            // Read output within max_bytes limit
            let mut out = Vec::new();
            child.stdout.take().unwrap().take(max_bytes as u64).read_to_end(&mut out).ok();
            Ok(out)
        }
        Ok(None) => {
            // Timeout expired
            child.kill().ok();
            child.wait().ok(); // Reap to prevent zombies
            Err("Execution timed out".to_string())
        }
        Err(e) => {
            child.kill().ok();
            child.wait().ok();
            Err(e.to_string())
        }
    }
}
```

---

### 3.2 File I/O, Path Normalization, and Symlink Attacks

Desktop security requires strict validation of files deleted during local data purges (`clear_local_data`). Raw lexical path matching is almost always broken.

#### The Code Smells & Traps
1.  **Raw Path Deletion Mismatch:**
    Validating a relative path (like `"clip.wav"`) against `audio_dir` inside a validation function, but then handing the *unmodified raw input* to `std::fs::remove_file`, causes the deletion to resolve against the process's working directory (`CWD`) instead of the intended storage directory. This leaks user data and risks collateral file loss in the application's launch directory.
2.  **Lexical Normalization Traversal Escapes:**
    A simple `.starts_with(audio_dir)` check fails against directory traversals (`..`) and symlink attacks. If an attacker places a symlink inside `audio_dir` pointing to `/etc/passwd`, a lexical-only validator sees `<audio_dir>/symlink/file` as "inside" the directory, allowing arbitrary file deletion or reading when followed.
3.  **Un-canonicalized Reference Directories:**
    If `audio_dir` itself contains relative components (`.` or `..`) due to system-specific paths or environmental configurations, every legitimate file path comparison will fail, causing the application to silently skip cleaning up user sensitive files.

#### The Hardened Architectural Pattern
*   **Always Canonicalize Both Ends:** Resolve the parent directory of the file and the target storage folder into absolute, canonical physical paths (`std::fs::canonicalize`) before comparing them.
*   **Validate the Canonical Path, Delete the Canonical Path:** Never delete the raw string input; always operate on the normalized, canonicalized path returned by your validator helper.

*Example Implementation:*
```rust
use std::path::{Path, PathBuf};
use std::fs;

pub fn resolve_managed_audio_path(path: &Path, audio_dir: &Path) -> Option<PathBuf> {
    // Merge relative inputs into the target audio directory
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        audio_dir.join(path)
    };

    let file_name = candidate.file_name()?;
    let parent_dir = candidate.parent()?;

    // Canonicalize parent and audio_dir to resolve traversals/symlinks
    let real_parent = fs::canonicalize(parent_dir).ok()?;
    let real_audio_dir = fs::canonicalize(audio_dir).ok()?;

    if real_parent != real_audio_dir {
        return None; // Escape or mismatch detected!
    }

    Some(real_parent.join(file_name))
}
```

---

### 3.3 Secure Network Streaming & Redirect Validation

Downloading installers or model sidecars is a critical attack vector for desktop software. Unhardened HTTP clients can be manipulated to download arbitrary malicious payloads.

#### The Code Smells & Traps
1.  **Unbounded Memory Buffering of Large Payloads:**
    Invoking standard helpers like `response.bytes()` blocks the thread and attempts to buffer the entire file in RAM before asserting any file size limit. Download targets like macOS `.pkg` files can be hundreds of megabytes or gigabytes, leading to instant OOM crashes.
2.  **Post-Download Validation (Too Late):**
    Asserting file size caps after the download completes is a security anti-pattern. An attacker-controlled server can keep sending an infinite stream of junk data, filling the host disk and crashing the operating system.
3.  **Redirect Allow-List Bypass:**
    While the initial URL (e.g., pointing to `github.com`) might be validated and allow-listed, HTTP clients follow redirects by default. If the server redirects the client to `evil-attacker.com/malware.pkg`, the client will fetch the malicious payload and proceed to execute it.

#### The Hardened Architectural Pattern
*   **Verify Redirects on Every Single Hop:** Supply a custom redirect policy to the HTTP client that forces every single target hop (including scheme, host, and file extension) to pass the security filter.
*   **Verify Content-Length & Stream to Disk with a Byte Counter:** Read chunks of bytes sequentially, write them to disk, and verify on every iteration that the total written bytes have not crossed the safety threshold. Reject the stream immediately if `Content-Length` is missing or exceeds the cap before the download begins.

*Example Implementation:*
```rust
use reqwest::redirect::Policy;
use std::fs::File;
use std::io::Write;

pub async fn download_installer(url_str: &str, dest_path: &Path, max_bytes: u64) -> Result<(), String> {
    let redirect_policy = Policy::custom(move |attempt| {
        let next_url = attempt.url();
        if attempt.previous().len() >= 10 {
            return attempt.error("Too many redirects");
        }
        // Validate next_url host/scheme here
        if !is_host_trusted(next_url) {
            return attempt.error("Untrusted redirect host");
        }
        attempt.follow()
    });

    let client = reqwest::Client::builder()
        .redirect(redirect_policy)
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client.get(url_str).send().await.map_err(|e| e.to_string())?;
    
    // Check advertised size
    if let Some(len) = response.content_length() {
        if len > max_bytes {
            return Err("Payload exceeds maximum size limit".to_string());
        }
    }

    let mut file = File::create(dest_path).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > max_bytes {
            drop(file);
            let _ = fs::remove_file(dest_path);
            return Err("Payload size limit breached during download".to_string());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
    }

    Ok(())
}
```

---

### 3.4 Concurrency Controls, Global Atomic Flags, and Parallel Test Integrity

Desktop platforms rely on global atomic states to manage hardware-level loops (like typing-simulators or speech recorders). This demands precise synchronization.

#### The Code Smells & Traps
1.  **Unscoped Global Action Cancellation:**
    If a typing cancel signal (`cancel_typing`) is modeled as a simple, process-global `CANCEL_TYPING` flag with no session key, triggering a cancellation near the end of session A will linger. When session B starts, it will instantly abort.
2.  **Dirty Test Contexts in Multi-threaded Cargo Tests:**
    Because Cargo executes tests concurrently in parallel threads within a single process, writing to shared process-global states (like `CANCEL_TYPING.store(true)`) causes other concurrent tests to fail randomly. Tests must be self-contained or carefully restore changed static states.

#### The Hardened Architectural Pattern
*   **Protect State Transitions via Local Contexts:** In unit tests, abstract atomic variables into helper functions or test structs rather than modifying global static variables directly. If global states must be tested, back up and restore their values in a `Drop` guard.
*   **No-Op Outside Active Sessions:** Ensure that commands representing global cancels do not run unless the global state is actively marked as in-progress.

---

### 3.5 SQLite & Migration Parsing Integrity

Database operations in `mausVoice` are driven by SQLite. During local data wipes, the application commits to deleting all traces of personal user data.

#### The Code Smells & Traps
*   **Tautological Table Assertions:** Developers often write tests that assert `USER_DATA_TABLES_TO_CLEAR` matches a copy-pasted list inside their test file. This is tautological: if a developer adds a new table (e.g. `voice_profiles`) but forgets to update both lists, the test still passes, creating a privacy leak.
*   **Transaction Silencing:** Wiping tables individually without wrapping them inside a SQL transaction (`pool.begin()`) leaves the database in an inconsistent or partially-wiped state if an intermediate deletion fails.

#### The Hardened Architectural Pattern
*   **Dynamic Migration Auditing:** Write tests that dynamically read migration files or the active SQLite schema (`sqlite_master` table), subtract an explicit public allow-list (e.g., `sqlite_sequence`), and assert that every other table is covered by the wipe statement. This creates a compiler-enforced block against un-cleared user tables.

*Example Implementation:*
```rust
#[tokio::test]
async fn test_all_user_tables_are_cleared() {
    let pool = establish_test_db().await;
    
    // Extract actual database tables dynamically from SQLite
    let tables: Vec<String> = sqlx::query_as::<_, (String,)>("SELECT name FROM sqlite_master WHERE type='table'")
        .fetch_all(&pool)
        .await
        .unwrap()
        .into_iter()
        .map(|t| t.0)
        .filter(|name| name != "sqlite_sequence" && name != "migrations")
        .collect();

    for table in tables {
        assert!(
            USER_DATA_TABLES_TO_CLEAR.contains(&table.as_str()),
            "Table '{table}' is missing from USER_DATA_TABLES_TO_CLEAR! This is a potential privacy leak."
        );
    }
}
```

---

### 3.6 Tauri IPC Bridge, CORS, and CSP Policies

Tauri applications communicate with the frontend using IPC (Inter-Process Communication). Misconfigured IPC access or Content Security Policies (CSP) can allow an attacker-controlled webview to execute native shell commands.

#### The Code Smells & Traps
*   **Over-Permissive remote.urls Allow-Lists:** Adding wildcards to your `remote.urls` capabilities allows any loaded sub-page (including external documentation or documentation mirrors) to call native commands like file deletes or command execution.
*   **Stale Comments on IPC Ownership:** Keeping comments that state "external site X has full IPC access" when the configuration file actually restricts it leads to developer confusion and incorrect security assumptions during audits.

#### The Hardened Architectural Pattern
*   **Enforce Zero-IPC for External Domains:** Limit `remote.urls` strictly to `localhost` loopbacks used for local development. External domains like GitHub Pages docs site must remain standard webviews without IPC privileges.
*   **Unified CSP Declarations:** Synchronize Content Security Policies inside `tauri.conf.json` with the production app, ensuring that external script execution is blocked (`script-src 'self'`).

---

### 3.7 Desktop-Native Pills & Multi-Platform Window Geometry

`mausVoice` relies on native tray pills drawn via platform-specific window frameworks (Cocoa on macOS, Win32 on Windows, and GTK/X11 on Linux). Window coordinate and scaling calculations represent a major source of visual bugs.

#### The Code Smells & Traps
*   ** Toplevel Origin vs. Center Anchoring:** When drag-dropping the Linux X11 pill, capturing the raw window coordinates can save coordinates belonging to a transparent toplevel origin rather than the visible pill center. This can cause the pill to leap to a different screen or snap back to the primary monitor on display-crossing events.
*   **Exclusive Boundary Probes:** Testing coordinate containment with strict less-than operators against screen boundaries can cause fallbacks to fail on screen edges, leaving the tray pill inaccessible.

#### The Hardened Architectural Pattern
*   **Universal Center Offset calculations:** Always offset toplevel coordinates by half the window width and height, matching macOS and Windows center-anchoring methods.
*   **Inward Boundary Anchoring:** When computing initial placement fallbacks, position the coordinate target strictly within the screen boundary (e.g. subtracting `1.0` pixel from the exclusive maximum boundary).

---

### 3.8 Global Model Cache Serialization & Resource Contention

Local AI audio transcription utilizes ONNX Runtime and Parakeet models. These models represent massive memory and CPU footprints, requiring careful global caching.

#### The Code Smells & Traps
*   **Coarse-Grained Mutex Holding:** Locking a global model cache mutex (e.g. `MODEL_CACHE.lock()`) and holding it *across the entire duration of a long-running audio inference task* serializes all local speech transcription requests. If a user tries to process an in-flight speech query and runs a separate local command, the secondary query is frozen until the first completes.
*   **Lock Contention Under Parallel Requests:** Multiple parallel webviews or background tasks attempting to call local models simultaneously will lead to high latency and thread-pool exhaustion if locks are held past initial model retrieval.

#### The Hardened Architectural Pattern
*   **Acquire, Clone, and Drop:** Acquire the global mutex strictly to query, clone, or load the underlying model runtime handle. Drop the guard (`drop(cache)`) instantly before starting the heavy, non-blocking model computation, allowing other commands to query the cache concurrently.

*Example Implementation:*
```rust
// HARDENED CACHE RETRIEVAL
pub async fn transcribe_samples(samples: Vec<f32>) -> Result<String, String> {
    let model_runtime = {
        let mut cache = MODEL_CACHE.lock().map_err(|_| "Cache lock poisoned")?;
        let loaded = cache.get_or_load_model()?;
        // Clone the light Arced pointer to the runtime, not the model weights
        loaded.runtime_handle.clone() 
    }; // The guard is dropped here automatically

    // Perform heavy inference concurrently without blocking other queries
    model_runtime.run_inference(samples).await
}
```

---

### 3.9 ONNX Auxiliary Artifact Download Lifecycle

Models like Canary or Parakeet require companion files (tokenizers, vocabularies, configuration graphs). If these are managed with detached tasks, reliability breaks.

#### The Code Smells & Traps
*   **Fire-and-Forget Companion Spawns (`tokio::spawn`):** Spawning auxiliary file downloads (e.g. tokenizer configs) as background tasks and discarding their join handles (`let _ = tokio::spawn(...)`) leaves errors unhandled. If a configuration file download fails due to a network drop, the model remains partially downloaded, resulting in silent model load failures on subsequent boot-ups.
*   **Flaky Fixed Sleep Waits in Tests:** Using a fixed time delay (e.g. `sleep(Duration::from_secs(30))`) inside integration tests to allow detached companion downloads to finish is highly brittle and causes flaky builds on slow, resource-constrained runner environments.

#### The Hardened Architectural Pattern
*   **Await the Complete Artifact Set:** Never spawn detached, un-tracked companion tasks for critical model runtime dependencies. Aggregate all artifact download futures and await them completely (`tokio::try_join!`) before reporting the model status as ready.
*   **Test Readiness Poll Loops:** In tests, poll the actual model readiness status endpoint rather than hardcoding arbitrary sleeps.

---

## 4. TypeScript & React Frontend Lifecycle Contracts

### 4.1 React Hooks & StrictMode Compliance

React's StrictMode renders components twice to detect side effects. Any hook that violates React's pure-rendering lifecycle guidelines will cause memory leaks or state drift.

#### The Code Smells & Traps
1.  **Writing to Refs During Render:**
    Executing code like `ref.current = value` or setting states directly in the render function body is a forbidden side effect. If React aborts or rerenders the transition, your ref stores inaccurate state.
2.  **Stale/Frozen Constants in Memoized Refs:**
    Creating a ref-guarded controller once (`if (!ref.current) ref.current = new Controller(options)`) means that any subsequent changes to `options` are completely ignored. This silently freezes configurations like the safety timeout `timeoutMs`.

#### The Hardened Architectural Pattern
*   **Execute Ref Assignments inside Effects:** Let components render purely. Perform setup or synchronization inside a `useEffect` hook.
*   **Stable Identity Setters, Dynamic Call parameters:** Avoid state sinks inside refs. Instead, pass dynamic configurations (like timeouts) directly as method arguments during execution (e.g., `controller.run(promise, timeoutMs)`).

---

### 4.2 Safe Async State Transitions & Race Conditions

Desktop user interactions are highly dynamic—users click things repeatedly, and network speeds fluctuate. Async hooks must guarantee that stale responses do not update UI state.

#### The Code Smells & Traps
1.  **Surfacing Stale Async Results:**
    If a user requests a data reload and immediately clicks refresh again, two parallel network queries run. If the older request finishes *after* the newer one, it will overwrite the UI state with stale, outdated data.
2.  **Setting State on Unmounted Components:**
    Updating standard state hooks after a component has unmounted produces memory leaks and console warnings. 

#### The Hardened Architectural Pattern
*   **Monotonic Generation Counters:** Use an incrementing counter (`generation`) inside an async controller. On completion, only apply state updates if the generation matched the start token.
*   **Teardown Hooks:** Return cancel/teardown handlers in `useEffect` that instantly increment the generation, discarding any pending updates.

*Example Implementation:*
```typescript
export class AsyncDataController<T> {
  private generation = 0;
  private timeout: any = null;

  constructor(
    private readonly sink: {
      setLoading: (l: boolean) => void;
      setError: (e: string) => void;
      setData: (d: T) => void;
    },
    private readonly defaultTimeoutMs: number,
  ) {}

  public cancelInFlight() {
    this.generation++;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  public async run(promise: () => Promise<T>, timeoutMs = this.defaultTimeoutMs): Promise<void> {
    const myGeneration = ++this.generation;
    this.cancelInFlight(); // Cancel previous run

    this.sink.setLoading(true);
    this.sink.setError("");

    this.timeout = setTimeout(() => {
      if (this.generation !== myGeneration) return;
      this.generation++;
      this.sink.setError("Request timed out");
      this.sink.setLoading(false);
    }, timeoutMs);

    try {
      const data = await promise();
      if (this.generation !== myGeneration) return;
      this.sink.setData(data);
      this.sink.setLoading(false);
    } catch (err) {
      if (this.generation !== myGeneration) return;
      this.sink.setError(String(err));
      this.sink.setLoading(false);
    } finally {
      if (this.generation === myGeneration) {
        clearTimeout(this.timeout);
      }
    }
  }
}
```

---

### 4.3 IPC Protocol Integration & Binding Alignment

Tauri coordinates the Rust and TS runtimes through code generation (via `specta` or equivalent). If manual edits diverge from the generated bindings, the app will crash at runtime.

#### Rules for Agents
1.  **Never Manually edit `bindings.ts`:**
    Always regenerate bindings by running `scripts/bindings.sh` or through cargo build flows when updating command signatures in `commands.rs`.
2.  **Synchronize Commands in `app.rs`:**
    New Tauri commands must be registered in the builder inside `app.rs`. Double check that any command added to `commands.rs` matches its registration hook.

---

### 4.4 Audio Input and Pulse Recording Safety

Audio processing loops demand safety strategies to handle raw buffers from hardware recording channels.

#### The Code Smells & Traps
*   **Un-synchronized Pulse Streams:** Failing to close or pause microphone streams upon component unmounting leaks audio handles and keeps the recording indicator active on the host OS.
*   **C-style Buffer Index Traversal:** Manually parsing raw `Float32Array` PCM audio buffers using unchecked index traversals can cause index-out-of-bounds exceptions, terminating the recording thread.

#### The Hardened Architectural Pattern
*   **Enforce Unmount Subscriptions:** Every active audio node or microphone listener hook must hook into standard `useEffect` cleanups to terminate the recording stream.
*   **Bounds-Guarded Buffer Iteration:** Always use built-in array methods or robust range guards when splitting or merging audio signals.

---

### 4.5 Host Default Device Drop-off during Cache Enumeration

Desktop users frequently connect or disconnect microphones. Enumerating system inputs can cause active defaults to drop off.

#### The Code Smells & Traps
*   **Silent Default Device Drops:** When the default recording device cannot resolve a display name, standard normalization loops can fall back to returning `None` for the device name. When the loop processes this, it strips out the `is_default` property from the list, causing the UI to show *no default microphone at all*.
*   **Label-Based Cache Enumeration Costs:** Resolving the active microphone on recording start by doing a label-based search over all devices on the host forces full hardware-level enumeration on every single toggle. This introduces stuttering and delay to the audio stream initialization.

#### The Hardened Architectural Pattern
*   **Defensive Default Preservations:** If a display name query fails on the default hardware device, fallback to assigning a stable placeholder label (like `"System Default"`) rather than dropping the default indicator.
*   **Persistent Index/ID Cache:** Cache and target microphones by stable system-level hardware IDs rather than doing dynamic string label lookups.

---

## 5. CI/CD & Monorepo Dependency Orchestration

### 5.1 Turborepo Task Graph Dependency Integrity

In a monorepo setup, task definitions in `turbo.json` must be self-sufficient and accurately reflect their dependency graph.

#### The Trap
Declaring a task like `"check-types"` with `"dependsOn": ["^check-types"]` means it will only look for types inside dependent packages. If those dependent packages have not compiled their sources into `/dist` first, `tsc` will fail with spurious `TS2307` (Cannot find module) errors.

#### The Fix
Configure `check-types` to depend on built packages directly:
```json
"check-types": {
  "dependsOn": ["^build"]
}
```

---

### 5.2 Minimal-Privilege Workflow Scopes

GitHub Actions workflows should strictly limit the permissions assigned to `GITHUB_TOKEN`.

#### Rule of Thumb
Never let standard verification tasks (like formatting, linting, typechecking, and cargo tests) run with write-access tokens. Explicitly limit job-level permissions:
```yaml
permissions:
  contents: read
```
Only allow writing inside publishing and release deployment steps.

---

### 5.3 Exact Monorepo Trigger Filters

Monorepo CI workflows use `paths` filters to prevent running expensive builds on unrelated commits (like markdown docs). However, missing internal dependency changes will bypass CI checks.

#### Standard Monorepo Workflow Filters
Ensure that `paths` filters for the desktop build workflow include every file that impacts compilation:
```yaml
paths:
  - "apps/desktop/**"
  - "packages/**"
  - "patches/**"
  - "package.json"
  - "pnpm-lock.yaml"
  - "pnpm-workspace.yaml"
  - "turbo.json"
  - ".nvmrc"
  - ".github/scripts/install-desktop-linux-deps.sh"
```

---

### 5.4 Hardened Package Resolution & Dependency Floors

When applying lockfile overrides for security patches, avoid omitting lower-bound constraints.

#### The Vulnerability
Changing an override constraint from `"vitest@<3.2.6": ">=3.2.6 <4.0.0"` to `"vitest@<3.2.6": "<4.0.0"` removes the lower bound constraint entirely. This means a package resolution step could downgrade the package to a vulnerable version of `3.x` while satisfying the relaxed constraint. Always preserve the floor and ceiling:
```json
"vitest@<3.2.6": ">=3.2.6 <4.0.0"
```

---

### 5.5 Committed Secrets & Updater Public Key Trust Anchors

Tauri apps use public/private keypairs to sign and verify application updates. Storing these public anchors inside the public repository exposes trust.

#### The Code Smells & Traps
*   **Committed Signing Keys:** Storing updater private keys or public verification key strings (`__UPDATER_PUBLIC_KEY__`) directly inside code files or repository-visible workflow configurations allows any fork to sign malicious binaries that the production app will trust and auto-update.
*   **Drifting Key Literals:** Hardcoding public key strings in both the CI/CD files and setup scripts instead of sharing a single, centralized environment variable introduces security drift.

#### The Hardened Architectural Pattern
*   **Disable Updaters when Un-signed:** Set `"createUpdaterArtifacts": false` within public configuration branches.
*   **Runtime Environment Injections:** Only inject the actual public signature verification key (`TAURI_UPDATER_PUBLIC_KEY`) during the restricted, runner-phase release build utilizing secured GitHub Repository Secrets.

---

### 5.6 Multi-Platform Workflows and Test Execution Gaps

Monorepos often split unit test suites by platform target. However, having asymmetrical tests across systems allows platform-specific regressions to go completely unnoticed.

#### The Code Smells & Traps
*   **Asymmetrical Crate Tests:** Frequently, only Windows crates (e.g., `rust_windows_pill`) are evaluated inside GitHub Actions via `cargo test`, while macOS (`rust_macos_pill`) and Linux (`rust_gtk_pill`) configurations are checked only with static `cargo clippy`. This allows runtime execution bugs on macOS and Linux to pass CI.
*   **Stale Package Index Installs:** Executing inline installations of tools (like `imagemagick` for icon checking) in workflows without running a pre-requisite system index update (`apt-get update`) leads to intermittent runner crashes when standard software mirrors update their remote catalogs.

#### The Hardened Architectural Pattern
*   **Balanced Platform Checks:** For every crate that compiled under specific architecture target filters, enforce equivalent execution checks (`cargo test`) inside the central workflow file.
*   **Unified Dependency Provisioning:** Consolidate external tool installations directly into the primary platform dependency provisioning scripts rather than running loose `apt-get` commands in separate actions.

---

### 5.7 Shell Context Evaluation and Boolean Cast Assumptions

Build and prep scripts often evaluate environment flags (like `CI=true` or `CI=false`) using native shell string matches.

#### The Code Smells & Traps
*   **String Boolean Truthy Pitfalls:** Scripts often cast environment properties like `process.env.CI` directly to a boolean context. In Node.js or Python, the string `"false"` is **truthy**. As a result, running a local setup script with `CI=false` is evaluated as *running under CI*, which can cause the local build to fail catastrophically when native compilation errors occur.

#### The Hardened Architectural Pattern
*   **Explicit String Comparison:** Always evaluate string variables by doing an explicit comparison with expected values (e.g. `process.env.CI !== "false"`).

---

## 6. The Definitive Suggestions & Nitpicks Guide

Not all findings block a release, but maintainability demands clean formatting, structural standards, and modern syntax conventions. This section provides the exhaustive categorization rules for minor findings (Suggestions) and style corrections (Nitpicks).

### 6.1 Suggestion Typology: Quality-of-Life, Defensive Coding, and Scalability

Suggestions focus on improving performance, ensuring long-term maintainability, and defensive programming. They are classified as `🟡 Minor` or `🔵 Trivial` suggestions.

#### Primary Suggestion Patterns:
1.  **Redundant Code & Dead Variable Stripping:**
    Unused local variables, dead imports, or parameters that are completely ignored by the function body. Stripping them keeps compiler analysis fast and the code highly readable.
2.  **Defensive Option Parsing:**
    Checking and resolving optional values with safe fallbacks instead of chaining risky unwraps (e.g., preferring `.unwrap_or_default()` or `if let Some` in Rust, and optional chaining `?.` with nullish coalescing `??` in TS).
3.  **Modern Idiom Adoptions:**
    *   **In Rust:** Using `std::mem::take` to extract state from a mutable reference, or utilizing iterator streams (`.any()`, `.map()`, `.find()`) over manual C-style `for` loops.
    *   **In TS:** Migrating deprecated array constructors to modern ES6 features, or replacing standard `Promise.then` chaining with clean `async/await` syntax.
4.  **Redundant Mutex holding optimization:**
    Identifying local scopes where a thread locks a resource and immediately triggers another nested command, causing micro-contention and visual rendering delays.

---

### 6.2 Nitpick Typology: Linters, Spacing, and Non-Functional Semantics

Nitpicks are purely structural or cosmetic changes that have **zero functional impact** on execution correctness. They ensure perfect style consistency across large development teams.

#### Primary Nitpick Patterns:
1.  **Formatting Drift & Stray Newlines:**
    Extra spaces, dangling blank lines inside blocks, trailing whitespaces, or missing empty lines below Markdown headings (e.g., `markdownlint` MD022 errors).
2.  **File Termination Standards:**
    Missing a single trailing newline at the end of files (e.g., `markdownlint` MD047 errors), which breaks some terminal-based concatenations.
3.  **Redundant / Drifted Comments:**
    Comments that contradict active code changes. Old, legacy comments claiming a function "throws X" when it was rewritten to return a `Result` must be scrubbed immediately.
4.  **Variable / Function Renaming:**
    Stylistic renaming proposals to make identifiers more descriptive, provided they follow standard monorepo casings (camelCase for TS, snake_case for Rust).

---

### 6.3 Code Quality & Linter Boundaries (Oxlint, Prettier, Markdownlint)

`mausVoice` integrates specific, automated static tools that compile and enforce styling criteria before code enters staging:
*   **Oxlint:** An extremely fast linter that scans the entire desktop frontend for common JavaScript/TypeScript traps (such as variable shadowing, redundant assignments, and unused imports) with zero configuration. It is run via `pnpm --filter desktop run lint`.
*   **Prettier:** Enforces code formatting consistency (such as strict quote casings and spacing limits) across all TypeScript, CSS, and Markdown assets.
*   **Markdownlint:** Enforces structural standards for Markdown files. It strictly checks that headings are surrounded by empty lines (MD022) and files end with a single trailing newline (MD047).

Audit reviews must verify that proposed suggestions and nitpicks do not violate these linter boundaries or cause formatting test failures in CI.

---

## 7. Universal Code Smell & Anti-Pattern Detection Checklist

| Category | Smell / Anti-Pattern | Severity | Remediation |
| :--- | :--- | :--- | :--- |
| **Rust Security** | Raw string path deletions | Critical | Canonicalize and map to returned valid PathBuf |
| **Rust Security** | Unvalidated HTTP Redirects | Critical | Custom Redirect policy verifying host, scheme, and path extension |
| **Rust Performance** | Buffering subprocess outputs inside RAM | Major | Stream stdout/stderr using capped readers with max bytes |
| **Rust Concurrency** | Parallel thread modification of static globals | Major | Wrap global state access or drop/backup within unit tests |
| **Rust Security** | Over-permissive remote URLs in Tauri configs | Critical | Enforce loopback localhost bounds for IPC capability |
| **Rust Robustness** | Tautological constants validation tests | Major | Parse schema definitions dynamically inside tests |
| **Rust UI** | Exclusive maximum bounds in geometry calculations | Medium | Position coordinates strictly within screen bounds |
| **Rust Concurrency** | Coarse-grained Mutex holding across long async tasks | Major | Clone/retrieve under short-scoped lock, then drop before async task |
| **Rust Operations** | Unhandled fire-and-forget companion spawns | Major | Aggregate all auxiliary download targets and await them as a set |
| **React Hooks** | Writing to Refs during render phase | Major | Use `useEffect` or pure state setters |
| **React Safety** | Obsolete or cached state controllers | Major | Update on changed parameters / dependencies |
| **React Lifecycle** | Memory leak / setting state on unmounted components | Medium | Increment generation count to discard pending re-renders |
| **TS Hardware** | Default input drop-off during label scan | Medium | Provide system placeholders for unnamed defaults |
| **CI / CD** | Over-privileged `GITHUB_TOKEN` scopes | Medium | Restrict jobs to `contents: read` |
| **Turborepo** | Tautological task dependency definitions | Medium | Force dependent outputs to require `^build` |
| **CI Security** | Committed private updater keys and public hooks | Critical | Shift signing to runtimes using secure environment secrets |
| **CI Coverage** | Asymmetrical crate verification runs across targets | Major | Enforce symmetrical `cargo test` configurations for all platforms |
| **Script Safety** | Casting env variables directly to Boolean states | Medium | Use explicit string comparison statements |
| **Clean Code** | Dangling, unused variables or dead system imports | Minor | Strip unused references completely to pass Oxlint clean scans |
| **Formatting** | Missing blank spaces around headings or EOF newlines | Nitpick | Add blank spaces and newlines to comply with Markdownlint checks |
| **Documentation** | Drifted comments contradicting active code signatures | Nitpick | Rewrite doc comments and functions to preserve semantic alignment |
| **Performance** | Redundant device label lookups inside hardware cycles | Minor | Target devices using direct indexed queries or cached identifiers |
