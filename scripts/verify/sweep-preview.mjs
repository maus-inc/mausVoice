// Walks every page of the preview app and reports the ones that render badly.
//
// The home page and the microphone dialog were each checked by hand once. This
// does the rest of the surface in one pass: it visits every route the index
// advertises, in light and dark, and records console errors, failed requests,
// empty renders, horizontal overflow and text that clips its own box.
//
//   node scripts/verify/sweep-preview.mjs [baseUrl]
import { mkdirSync, writeFileSync } from "node:fs";
import { launch, newPage, sleep } from "./cdp.mjs";

const OUT = process.env.OUT_DIR || "/home/user/mausVoice/reports/ui-verify";
mkdirSync(OUT, { recursive: true });
const BASE =
  process.argv[2] || process.env.PREVIEW_URL || "http://127.0.0.1:5193";
// A desktop window is the only thing this app promises, but the preview is a
// web page and gets resized. 1280 is the ordinary case; 900 is a small window.
const WIDTH = Number(process.env.SWEEP_WIDTH ?? process.argv[3] ?? 1280);
const HEIGHT = 900;

const ROUTE_TIMEOUT = 12000;

/** Everything that can be read off the DOM for one page, in one round trip. */
const PAGE_PROBE = `(() => {
  const text = (document.body.innerText || "").trim();
  const vw = window.innerWidth;
  const rect = (el) => el.getBoundingClientRect();
  // Elements that stick out to the right of the viewport. Only elements with
  // their own text count: a bare layout wrapper at width:100% is not a bug.
  const offscreen = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (!el.textContent || !el.textContent.trim()) continue;
    // A subtree hidden from assistive technology is a measurement mirror or a
    // decorative duplicate; it is allowed to sit anywhere.
    if (el.closest('[aria-hidden="true"]')) continue;
    const r = rect(el);
    if (r.width > 0 && r.right > vw + 1) {
      offscreen.push(el.tagName + "." + String(el.className).split(" ")[0]);
    }
  }
  // Text that is cut off mid-glyph: the box is shorter than its content and
  // nothing is allowed to scroll it.
  const clipped = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (!el.textContent || !el.textContent.trim() || el.children.length) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    // Ellipsis truncation is a deliberate choice; this looks for text that is
    // silently cut through the middle of a glyph.
    if (cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none") continue;
    if (cs.overflow !== "visible" && el.scrollHeight > el.clientHeight + 2 &&
        el.clientHeight > 0 && cs.textOverflow !== "ellipsis") {
      clipped.push(el.tagName + ":" + el.textContent.trim().slice(0, 30));
    }
  }
  return {
    textLength: text.length,
    rootChildren: document.getElementById("root")?.children.length ?? -1,
    docScrollWidth: document.documentElement.scrollWidth,
    viewport: vw,
    offscreen: [...new Set(offscreen)].slice(0, 6),
    clipped: [...new Set(clipped)].slice(0, 6),
    hasHeading: !!document.querySelector("h1, h2, h3"),
  };
})()`;

const { proc, port } = await launch({ width: WIDTH, height: HEIGHT });
const page = await newPage(port);

let currentErrors = [];
let currentFailed = [];
page.on("Runtime.consoleAPICalled", (p) => {
  if (p.type === "error")
    currentErrors.push(
      p.args
        .map((a) => a.value ?? a.description ?? "")
        .join(" ")
        .slice(0, 300),
    );
});
page.on("Runtime.exceptionThrown", (p) =>
  currentErrors.push(
    "exception: " +
      (p.exceptionDetails?.exception?.description ?? "").slice(0, 300),
  ),
);
await page.send("Network.enable");
await page.on("Network.loadingFailed", (p) => {
  if (p.type !== "Other") currentFailed.push(`${p.type}:${p.errorText}`);
});

await page.setViewport(WIDTH, HEIGHT);
await page.goto(`${BASE}/`);
// The index is a client-rendered React app, so an anchor count read too early
// is legitimately zero. Wait for the link list itself rather than for a clock.
let anchorCount = 0;
for (let attempt = 0; attempt < 20 && anchorCount === 0; attempt += 1) {
  await sleep(1000);
  anchorCount = await page
    .evaluate(`document.querySelectorAll('a[href^="#/"]').length`)
    .catch(() => 0);
}

const routes = await page.evaluate(
  `Array.from(document.querySelectorAll('a[href^="#/"]')).map(a => a.getAttribute('href'))`,
);
const unique = [...new Set(routes)];
console.log(`Visiting ${unique.length} routes.`);

const rows = [];
for (const theme of ["light", "dark"]) {
  await page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  for (const route of unique) {
    currentErrors = [];
    currentFailed = [];
    await page.goto(`${BASE}/${route}`);
    // Wait for the route to paint, then measure twice. Entry animations move
    // elements through positions outside the viewport on their way in, so a
    // single reading taken during one reports phantoms. Only what is still
    // displaced after the layout has settled counts.
    await sleep(1400);
    const first = await page.evaluate(PAGE_PROBE).catch((error) => ({
      failed: String(error).slice(0, 200),
    }));
    await sleep(900);
    const probe = await page.evaluate(PAGE_PROBE).catch((error) => ({
      failed: String(error).slice(0, 200),
    }));
    if (first.offscreen && probe.offscreen) {
      // Intersection, not union: an element that has arrived is not a problem.
      probe.offscreen = probe.offscreen.filter((item) =>
        first.offscreen.includes(item),
      );
    }
    if (first.clipped && probe.clipped) {
      probe.clipped = probe.clipped.filter((item) =>
        first.clipped.includes(item),
      );
    }
    const problems = [];
    if (probe.failed) problems.push(`probe failed: ${probe.failed}`);
    if (probe.rootChildren === 0) problems.push("nothing rendered");
    if (probe.rootChildren > 0 && probe.textLength === 0)
      problems.push("rendered but shows no text");
    if (probe.docScrollWidth > probe.viewport + 1)
      problems.push(
        `horizontal scroll ${probe.docScrollWidth}px > ${probe.viewport}px`,
      );
    if (probe.offscreen?.length)
      problems.push(`offscreen: ${probe.offscreen.join(", ")}`);
    if (probe.clipped?.length)
      problems.push(`clipped text: ${probe.clipped.join(", ")}`);
    if (currentErrors.length)
      problems.push(`${currentErrors.length} console error(s)`);
    if (currentFailed.length)
      problems.push(`${currentFailed.length} failed request(s)`);

    rows.push({ theme, route, problems, textLength: probe.textLength });
    if (problems.length) {
      console.log(`[${theme}] ${route}`);
      for (const p of problems) console.log(`    ${p}`);
      if (currentErrors.length)
        console.log(`    first error: ${currentErrors[0].slice(0, 200)}`);
    }
  }
}

await page.send("Emulation.setEmulatedMedia", { features: [] });
await page.close();
proc.kill("SIGKILL");

writeFileSync(
  `${OUT}/sweep-preview-${WIDTH}.json`,
  JSON.stringify(rows, null, 2),
);

const broken = rows.filter((r) => r.problems.length);
const brokenRoutes = new Set(broken.map((r) => r.route.split("?")[0]));
console.log(
  `\n${rows.length} page loads, ${broken.length} with problems across ${brokenRoutes.size} route(s) of ${unique.length}.`,
);
if (broken.length) process.exitCode = 1;
