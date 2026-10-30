/**
 * Canonical names for the desktop dev-surface gating configuration.
 *
 * These constants are the single source of truth consumed by the contract
 * tests (`dev-surface-contracts.test.mjs`). The corresponding values in
 * `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/src/app.rs`,
 * and `apps/desktop/package.json` MUST agree with the identifiers declared
 * here — the contract tests enforce that invariant.
 *
 * If you ever rename the Cargo feature, change the environment variable, or
 * swap the Tauri capability feature, update this file first; the tests will
 * flag every downstream site that fell out of sync.
 */

/** Cargo feature that opts into Tauri devtools at compile time. */
export const CARGO_FEATURE = "debug-assist";

/**
 * Tauri Cargo feature unlocked by {@link CARGO_FEATURE}.
 * Expressed as `<crate>/<feature>` to match the Cargo.toml feature syntax.
 */
export const TAURI_DEVTOOLS_FEATURE = "tauri/devtools";

/**
 * Runtime environment variable that gates devtools opening.
 * Only effective when the binary was compiled with {@link CARGO_FEATURE}.
 */
export const DEVTOOLS_ENV_VAR = "MAUSVOICE_ENABLE_DEVTOOLS";
