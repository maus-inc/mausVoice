// Screenshots the preview index and records its route list.
//
// The settings dialog is not here: `shot-mic-dialog.mjs` owns that, through the
// verification harness. This one navigates to the preview app's own index, so
// the picture it writes shows the index.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, newPage, sleep } from "./cdp.mjs";

// Repository-relative, resolved from this file rather than from the shell's
// working directory or a sandbox path: a committed file may not carry an
// absolute path, and the screenshots belong beside the report that cites them.
//
// `fileURLToPath`, not `URL.pathname`: `pathname` percent-encodes, so a checkout
// under a path with a space wrote to a directory that literally contained `%20`.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT_DIR || join(REPO_ROOT, "reports/ui-verify");
mkdirSync(OUT, { recursive: true });

const BASE = process.env.PREVIEW_URL || "http://127.0.0.1:5193";

const { port, cleanup } = await launch({ width: 1280, height: 900 });
const page = await newPage(port);

const consoleErrors = [];
page.on("Runtime.consoleAPICalled", (params) => {
  if (params.type === "error") {
    consoleErrors.push(
      params.args.map((a) => a.value ?? a.description ?? "").join(" "),
    );
  }
});
const failedRequests = [];
page.on("Network.loadingFailed", (p) => failedRequests.push(p.errorText));

await page.send("Network.enable");
await page.setViewport(1280, 900);
await page.goto(`${BASE}/`);
await sleep(6000);

const title = await page.evaluate("document.title");
const bodyText = await page.evaluate("document.body.innerText.slice(0, 400)");
console.log("TITLE:", JSON.stringify(title));
console.log("BODY:", JSON.stringify(bodyText));

// Look for a route that shows the settings dialog.
const routes = await page.evaluate(
  "Array.from(document.querySelectorAll('a')).map(a=>a.getAttribute('href')).slice(0,40)",
);
console.log("ROUTES:", JSON.stringify(routes));

writeFileSync(`${OUT}/home.png`, await page.screenshot());
console.log("wrote", `${OUT}/home.png`);
console.log("CONSOLE_ERRORS:", JSON.stringify(consoleErrors.slice(0, 10)));
console.log("FAILED_REQUESTS:", JSON.stringify(failedRequests.slice(0, 10)));

page.close();
cleanup();
