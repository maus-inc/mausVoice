import { pathToFileURL } from "node:url";

// URL conversion handles spaces and drive-letter paths without constructing an
// invalid file:// URL. `windows` is explicit so both path forms can be tested.
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

export async function runIfDirect(moduleUrl, main) {
  if (!isDirectInvocation(moduleUrl, process.argv[1])) return;
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
