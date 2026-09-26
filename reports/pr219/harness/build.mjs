// Bundles evidence.ts with two module graphs: "new:" is the working tree and
// "old:" is the same path loaded from the PR base commit via `git show`, with
// every relative import inside it also read from that commit.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
// esbuild is not hoisted; borrow the copy vite depends on in apps/desktop.
const desktopRequire = createRequire(path.join(repo, "apps/desktop/package.json"));
const { build } = createRequire(desktopRequire.resolve("vite"))("esbuild");
const BASE = process.env.PR219_BASE ?? "d1f06ec";
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

const blobs = new Set(
  execFileSync("git", ["ls-tree", "-r", "--name-only", BASE], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).split("\n"),
);

const gitShow = (rel) =>
  execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: repo, encoding: "utf8" });

const resolveOld = (rel) => {
  const match = EXTENSIONS.map((ext) => rel + ext).find((p) => blobs.has(p));
  if (!match) throw new Error(`old:${rel} not found at ${BASE}`);
  return match;
};

const resolveNew = (rel) => {
  const match = EXTENSIONS.map((ext) => path.join(repo, rel + ext)).find(
    (p) => existsSync(p) && statSync(p).isFile(),
  );
  if (!match) throw new Error(`new:${rel} not found`);
  return match;
};

const oldGraph = {
  name: "old-graph",
  setup(b) {
    b.onResolve({ filter: /^old:/ }, (args) => ({
      path: resolveOld(args.path.slice(4)),
      namespace: "old",
    }));
    b.onResolve({ filter: /^\./, namespace: "old" }, (args) => ({
      path: resolveOld(path.posix.join(path.posix.dirname(args.importer), args.path)),
      namespace: "old",
    }));
    b.onResolve({ filter: /^new:/ }, (args) => ({
      path: resolveNew(args.path.slice(4)),
    }));
    b.onLoad({ filter: /.*/, namespace: "old" }, (args) => ({
      contents: gitShow(args.path),
      loader: path.extname(args.path).slice(1),
      resolveDir: path.join(repo, path.posix.dirname(args.path)),
    }));
  },
};

await build({
  entryPoints: [path.join(here, "evidence.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(repo, "node_modules/.cache/pr219-evidence.mjs"),
  plugins: [oldGraph],
  define: {
    "process.env.PR219_BASE": JSON.stringify(BASE),
    // prompt.utils pulls in app modules that read Vite's env at import time.
    "import.meta.env": JSON.stringify({ MODE: "test", DEV: false, PROD: false }),
  },
  logLevel: "warning",
});
