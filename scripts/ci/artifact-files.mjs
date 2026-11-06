import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Walk an artifact tree without following enumerated symlinks. Reject a
 * symlink root too; the caller must control the tree against concurrent
 * mutation. Missing directories are empty, but other errors fail publication.
 */
export async function collectArtifactFiles(dir, readDir = readdir) {
  const root = await lstat(path.resolve(dir)).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!root) return [];
  if (root.isSymbolicLink())
    throw new Error("Artifact root must not be a symlink");
  const files = [];
  const queue = [dir];
  while (queue.length) {
    const current = queue.pop();
    const entries = await readDir(current, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}
