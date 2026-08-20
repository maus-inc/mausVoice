import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function readOnlyBuiltDependencies(workspaceYaml) {
  const packages = [];
  let inList = false;
  for (const line of workspaceYaml.split(/\r?\n/)) {
    if (line === "onlyBuiltDependencies:") {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const match = line.match(/^ {2}- ["']?([^"']+)["']?\s*$/);
    if (match) {
      packages.push(match[1]);
      continue;
    }
    if (line.trim() === "") continue;
    break;
  }
  if (packages.length === 0) {
    throw new Error("pnpm-workspace.yaml has no onlyBuiltDependencies entries");
  }
  return packages;
}

export function rebuildCommand(packages) {
  return ["pnpm", "rebuild", ...packages];
}

const invokedDirectly =
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const packages = readOnlyBuiltDependencies(
    readFileSync(resolve(repoRoot, "pnpm-workspace.yaml"), "utf8"),
  );
  const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(pnpmBin, ["rebuild", ...packages], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
