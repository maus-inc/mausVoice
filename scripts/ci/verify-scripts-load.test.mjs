import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPage } from "../verify/page-watch.mjs";

/**
 * Every script under `scripts/verify/` has to be loadable.
 *
 * These scripts drive a headless browser and write the measurements the QA
 * documents cite, so a throw at module scope is a measurement nobody can
 * reproduce. Nothing checked that before, and one of them shipped dead: a
 * `const URL = ...` at module scope put the global `URL` into its temporal dead
 * zone, so a `new URL(...)` twelve lines above it threw
 * `ReferenceError: Cannot access 'URL' before initialization`. `node --check`
 * passes that file, because the shadowing is legal JavaScript.
 *
 * Two checks, both static because importing the scripts would launch Chromium:
 *
 * 1. No module declares a binding that shadows a global its own module uses.
 * 2. `node --check` accepts the file, which catches syntax errors.
 */

// `fileURLToPath`, not `.pathname`: a checkout path containing a space is
// percent-encoded in `pathname`, so `readdirSync` below would be handed
// `/home/me/my%20repo/...` and fail to find a directory that is there.
const VERIFY_DIR = fileURLToPath(
  new URL("../../scripts/verify/", import.meta.url),
);

/** Globals these scripts legitimately reach for. */
const SHADOWABLE_GLOBALS = [
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "structuredClone",
  "fetch",
  "process",
  "console",
  "Buffer",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "queueMicrotask",
  "performance",
  "crypto",
];

const scriptNames = readdirSync(VERIFY_DIR).filter((name) =>
  name.endsWith(".mjs"),
);

test("the verify directory has scripts to check", () => {
  assert.ok(scriptNames.length > 0, "expected at least one script");
});

// Check 2 from the header. The shadowing check below cannot see a syntax error,
// and nothing else here imports these files, so Node parses each one itself.
for (const name of scriptNames) {
  test(`${name} parses`, () => {
    execFileSync(process.execPath, ["--check", join(VERIFY_DIR, name)], {
      stdio: "pipe",
    });
  });
}

for (const name of scriptNames) {
  test(`${name} does not shadow a global it uses`, () => {
    const source = readFileSync(join(VERIFY_DIR, name), "utf8");
    const offenders = [];

    for (const global of SHADOWABLE_GLOBALS) {
      // A top-level declaration of the global's name, at column zero.
      const declares = new RegExp(
        `^(?:const|let|var|function|class)\\s+${global}\\b`,
        "m",
      );
      if (!declares.test(source)) {
        continue;
      }
      // It is only a problem when the module also uses the *global*, which we
      // approximate by counting uses beyond the declaration itself: more than
      // one occurrence of the bare name outside comments and strings.
      const bare = source.match(
        new RegExp(`(?<![.\\w'"\`])${global}(?![\\w'"\`])`, "g"),
      );
      if ((bare?.length ?? 0) > 1) {
        offenders.push(global);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `${name} redeclares ${offenders.join(", ")} at module scope while also ` +
        `using the global; rename the local binding`,
    );
  });
}

const createFakePage = () => {
  const listeners = new Map();
  return {
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    emit(method, params) {
      for (const fn of listeners.get(method) ?? []) fn(params);
    },
  };
};

test("watchPage flags unexpected aborted requests on the active document", () => {
  const page = createFakePage();
  const { failedRequests, unexpectedFailedRequests } = watchPage(page);

  page.emit("Network.requestWillBeSent", {
    requestId: "doc-1",
    frameId: "frame-main",
    loaderId: "loader-1",
    type: "Document",
    request: { url: "http://127.0.0.1:5193/verify-harness/help.html" },
  });
  page.emit("Network.requestWillBeSent", {
    requestId: "img-1",
    frameId: "frame-main",
    loaderId: "loader-1",
    type: "Image",
    request: { url: "http://127.0.0.1:5193/assets/pattern.png" },
  });
  page.emit("Network.loadingFailed", {
    requestId: "img-1",
    type: "Image",
    errorText: "net::ERR_ABORTED",
    canceled: true,
  });

  assert.deepEqual(failedRequests, ["net::ERR_ABORTED"]);
  assert.deepEqual(unexpectedFailedRequests, [
    {
      url: "http://127.0.0.1:5193/assets/pattern.png",
      type: "Image",
      errorText: "net::ERR_ABORTED",
      canceled: true,
    },
  ]);
});

test("watchPage excludes canceled requests superseded by an intentional top-level navigation", () => {
  const page = createFakePage();
  const { failedRequests, unexpectedFailedRequests } = watchPage(page);

  page.emit("Network.requestWillBeSent", {
    requestId: "doc-1",
    frameId: "frame-main",
    loaderId: "loader-1",
    type: "Document",
    request: {
      url: "http://127.0.0.1:5193/verify-harness/help.html?view=help",
    },
  });
  page.emit("Network.requestWillBeSent", {
    requestId: "asset-1",
    frameId: "frame-main",
    loaderId: "loader-1",
    type: "Script",
    request: { url: "http://127.0.0.1:5193/chunk.js" },
  });
  page.emit("Network.requestWillBeSent", {
    requestId: "doc-2",
    frameId: "frame-main",
    loaderId: "loader-2",
    type: "Document",
    request: {
      url: "http://127.0.0.1:5193/verify-harness/help.html?view=dictionary",
    },
  });
  page.emit("Network.loadingFailed", {
    requestId: "asset-1",
    type: "Script",
    errorText: "net::ERR_ABORTED",
    canceled: true,
  });

  assert.deepEqual(failedRequests, ["net::ERR_ABORTED"]);
  assert.deepEqual(unexpectedFailedRequests, []);
});

test("watchPage does not let subframe document loads hide active main-frame aborts", () => {
  const page = createFakePage();
  const { unexpectedFailedRequests } = watchPage(page);

  page.emit("Page.frameNavigated", {
    frame: { id: "frame-main", loaderId: "loader-1" },
  });
  page.emit("Network.requestWillBeSent", {
    requestId: "font-1",
    frameId: "frame-main",
    loaderId: "loader-1",
    type: "Font",
    request: { url: "http://127.0.0.1:5193/fonts/Satoshi.woff2" },
  });
  page.emit("Network.requestWillBeSent", {
    requestId: "subdoc-1",
    frameId: "frame-child",
    loaderId: "loader-child",
    type: "Document",
    request: { url: "http://127.0.0.1:5193/frame.html" },
  });
  page.emit("Network.loadingFailed", {
    requestId: "font-1",
    type: "Font",
    errorText: "net::ERR_ABORTED",
    canceled: true,
  });

  assert.equal(unexpectedFailedRequests.length, 1);
  assert.equal(
    unexpectedFailedRequests[0].url,
    "http://127.0.0.1:5193/fonts/Satoshi.woff2",
  );
});
