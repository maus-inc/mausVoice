// Pure validation of the sherpa-onnx Windows runtime DLLs. Extracted from
// prepare-sidecars.mjs so the case-insensitive matching can be unit-tested
// without running the full sidecar build. The runtime script calls this and
// fails closed on `missingRequired` / warns on `missingOptional`, preserving
// the original behavior exactly.
//
// NOTE: kept as plain ESM (.mjs, no TS syntax) so it can be imported both by
// the Node build script (which cannot load .ts) and by vitest.

/**
 * @param {string[]} discovered raw on-disk file names (any casing)
 * @param {Set<string>} required required lower-case DLL names
 * @param {Set<string>} optional optional lower-case DLL names
 * @returns {{ missingRequired: string[]; missingOptional: string[] }}
 */
export function validateSherpaRuntimeDlls(discovered, required, optional) {
  const found = new Set(discovered.map((name) => name.toLowerCase()));
  const missingRequired = [...required].filter(
    (name) => !found.has(name.toLowerCase()),
  );
  const missingOptional = [...optional].filter(
    (name) => !found.has(name.toLowerCase()),
  );
  return { missingRequired, missingOptional };
}
