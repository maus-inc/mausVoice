import { rmSync } from "node:fs";

/** Track each frame before rendering and always attempt every cleanup. */
export function withTemporaryIconFiles(
  generate,
  remove = (path) => rmSync(path, { force: true }),
) {
  const files = [];
  const track = (path) => {
    files.push(path);
    return path;
  };
  let result;
  let failure;
  let failed = false;
  try {
    result = generate(track);
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanupErrors = [];
  for (const path of files) {
    try {
      remove(path);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    const errors = failed ? [failure, ...cleanupErrors] : cleanupErrors;
    throw new AggregateError(
      errors,
      `Icon generation/cleanup failed: ${errors.map(String).join("; ")}`,
    );
  }
  if (failed) throw failure;
  return result;
}
