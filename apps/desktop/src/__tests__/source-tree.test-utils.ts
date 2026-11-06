import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".git",
  "__tests__",
]);

/** Traverse source files without following links outside the reviewed tree. */
export function collectSourceFiles(dir: string): string[] {
  if (lstatSync(dir).isSymbolicLink()) {
    throw new Error(`Unexpected symbolic link in source tree: ${dir}`);
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Unexpected symbolic link in source tree: ${full}`);
    if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
      files.push(...collectSourceFiles(full));
    } else if (
      entry.isFile() &&
      /\.tsx?$/.test(entry.name) &&
      !/\.(?:test|spec)\./.test(entry.name)
    ) {
      files.push(full);
    }
  }
  return files;
}

/** Include desktop and every workspace package source, including Rust crates. */
export function contractSourceRoots(
  repoRoot: string,
  desktopRoot: string,
): string[] {
  const packages = resolve(repoRoot, "packages");
  const roots = [resolve(desktopRoot, "src")];
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error(`Unexpected symbolic link in packages: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const src = join(packages, entry.name, "src");
    const stat = lstatSync(src, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink())
      throw new Error(`Unexpected symbolic link in package sources: ${src}`);
    if (stat?.isDirectory()) roots.push(src);
  }
  return roots;
}
