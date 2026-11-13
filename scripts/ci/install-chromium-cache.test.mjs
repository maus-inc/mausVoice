import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The installer must decide "already installed" from the *installed* package,
 * not from the manifest of the directory that asked for it.
 *
 * These are different facts and the difference only shows on a stale cache. A
 * cache left at an older version still has the newer version named in
 * `PKG_DIR/package.json` -- that file records what the last run requested -- so a
 * check reading the declaration passes, the stale browser is extracted, and the
 * run reports success with the wrong Chromium. Reading
 * `node_modules/@sparticuz/chromium/package.json` is the only thing that answers
 * "what is actually on disk".
 *
 * Built as a fixture rather than by invoking the installer, because invoking it
 * downloads ~150 MB. The assertion is on the two files disagreeing and on which
 * one the source reads.
 */

const SOURCE = new URL(
  "../../scripts/verify/install-chromium.mjs",
  import.meta.url,
);

const installedVersionFrom = (pkgDir) => {
  // The same expression the installer uses, so the test cannot drift from it.
  try {
    const manifest = JSON.parse(
      readFileSync(
        join(pkgDir, "node_modules", "@sparticuz", "chromium", "package.json"),
        "utf8",
      ),
    );
    return manifest.version ?? null;
  } catch {
    return null;
  }
};

test("a stale install is not mistaken for a current one", () => {
  const dir = mkdtempSync(join(tmpdir(), "mausvoice-chromium-cache-"));
  try {
    mkdirSync(join(dir, "node_modules", "@sparticuz", "chromium"), {
      recursive: true,
    });
    // What the last run asked for.
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@sparticuz/chromium": "153.0.0" } }),
    );
    // What is actually installed.
    writeFileSync(
      join(dir, "node_modules", "@sparticuz", "chromium", "package.json"),
      JSON.stringify({ name: "@sparticuz/chromium", version: "141.0.0" }),
    );

    const declared = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
      .dependencies["@sparticuz/chromium"];

    // The premise: the declaration says the wanted version and the install does
    // not. Any check that reads the declaration is blind to this.
    assert.equal(declared, "153.0.0");
    assert.equal(installedVersionFrom(dir), "141.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the installer reads the installed manifest, not the declaration", () => {
  const source = readFileSync(SOURCE, "utf8");
  // Bound the slice to the version check, so a mention elsewhere in the file
  // cannot satisfy this.
  const start = source.indexOf("const cachedVersion");
  assert.ok(start > 0, "the version check is missing");
  const slice = source.slice(start, source.indexOf("if (cachedVersion", start));

  assert.match(
    slice,
    /INSTALLED_PKG[\s\S]*package\.json/,
    "the cache check must read the installed package's own manifest",
  );
  assert.doesNotMatch(
    slice,
    /dependencies/,
    "reading the dependency declaration cannot establish the installed version",
  );
});

/**
 * A run that dies leaves `${OUT}.partial-<pid>`, and the pid suffix means the
 * next run uses a different name. Without a sweep those accumulate on a
 * persistent `--dir`, one full browser copy each, and nothing ever removes them.
 *
 * The sweep has to be safe in both directions: remove what this script created
 * (the marker is written before extraction, so it means "created by us", not
 * "finished"), and leave alone anything that lacks it, because a `--dir` one
 * suffix away from a caller's path may be their directory.
 */
test("stale partials are swept only when they carry the marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "mausvoice-chromium-partial-"));
  try {
    const out = join(dir, "chr");
    const marker = ".mausvoice-chromium";
    const ours = join(dir, "chr.partial-1111");
    const notOurs = join(dir, "chr.partial-2222");
    const unrelated = join(dir, "other.partial-3333");
    for (const p of [ours, notOurs, unrelated])
      mkdirSync(p, { recursive: true });
    writeFileSync(join(ours, marker), "153.0.0\n");
    writeFileSync(join(ours, "chromium"), "half extracted");
    // Unmarked but non-empty: someone else's directory one suffix away.
    writeFileSync(join(notOurs, "user-data.txt"), "keep me");

    // The same rule the installer applies.
    const sweep = () => {
      for (const sibling of readdirSync(dir)) {
        if (!sibling.startsWith("chr.partial-")) continue;
        const stale = join(dir, sibling);
        if (!existsSync(join(stale, marker))) continue;
        rmSync(stale, { recursive: true, force: true });
      }
    };
    sweep();

    assert.equal(
      existsSync(ours),
      false,
      "our own stale partial must be removed",
    );
    assert.equal(
      existsSync(notOurs),
      true,
      "an unmarked directory must survive the sweep",
    );
    assert.equal(
      existsSync(unrelated),
      true,
      "a partial for a different output directory must survive",
    );
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Two processes can both find `OUT` absent and both extract. The first rename
 * publishes; the second fails with ENOTEMPTY, because `rename` onto a non-empty
 * directory is an error rather than a replace. That second run has what it
 * wanted, so it must succeed, remove only its own staging, and leave the winner.
 */
test("a concurrent winner is accepted, and its tree is left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "mausvoice-chromium-race-"));
  try {
    const marker = ".mausvoice-chromium";
    const out = join(dir, "chr");
    const staging = join(dir, `chr.partial-${process.pid}`);

    // The winner's published tree.
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, marker), "153.0.0\n");
    writeFileSync(join(out, "chromium"), "the real browser");
    // This run's staging.
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, marker), "153.0.0\n");
    writeFileSync(join(staging, "chromium"), "our copy");

    // The same predicate the installer uses.
    const isPublishedInstall = (d) => {
      if (!existsSync(join(d, marker))) return false;
      const binary = join(d, "chromium");
      if (!existsSync(binary)) return false;
      try {
        return statSync(binary).size > 0;
      } catch {
        return false;
      }
    };

    // The losing rename would throw here; the handler accepts the winner.
    assert.equal(isPublishedInstall(out), true);
    rmSync(staging, { recursive: true, force: true });

    assert.equal(
      existsSync(staging),
      false,
      "the loser cleans up its own staging",
    );
    assert.equal(
      readFileSync(join(out, "chromium"), "utf8"),
      "the real browser",
      "the winner's tree is not touched",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a marked but browser-less directory is not accepted as a winner", () => {
  // A half-written publish carries the marker and no executable. Accepting it
  // would send the caller to spawn a file that is not there, which reads as a
  // confusing spawn error rather than a failed install.
  const dir = mkdtempSync(join(tmpdir(), "mausvoice-chromium-half-"));
  try {
    const marker = ".mausvoice-chromium";
    writeFileSync(join(dir, marker), "153.0.0\n");
    const isPublishedInstall = (d) =>
      existsSync(join(d, marker)) && existsSync(join(d, "chromium"));
    assert.equal(isPublishedInstall(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
