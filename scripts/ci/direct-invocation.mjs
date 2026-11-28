// Whether a module is the entry point of the running process, and the runner
// that acts on the answer. Every CI script needs both, and four copies of the
// answer drifted: the version that went through `pathToFileURL` handles spaces
// and Windows drive letters, the version that concatenated a `file://` string
// did not, and a direct invocation silently skipped.
import { pathToFileURL } from "node:url";

export function isDirectInvocation(
  moduleUrl,
  scriptPath,
  windows = process.platform === "win32",
) {
  return (
    Boolean(scriptPath) &&
    moduleUrl === pathToFileURL(scriptPath, { windows }).href
  );
}

// Run `main` only when executed directly, so the tests can import the helpers.
export async function runIfDirect(moduleUrl, scriptPath, main) {
  if (!isDirectInvocation(moduleUrl, scriptPath)) {
    return;
  }
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
