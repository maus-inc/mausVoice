// Screenshots and measures the microphone dialog across the states a user sees.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, newPage, sleep } from "./cdp.mjs";

// Repository-relative, resolved from this file rather than from the shell's
// working directory or a sandbox path: a committed file may not carry an
// absolute path, and the screenshots belong beside the report that cites them.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT = process.env.OUT_DIR || join(REPO_ROOT, "reports/ui-verify");
mkdirSync(OUT, { recursive: true });

// Not named `URL`: a module-scope `const URL` puts the global that line 9 uses
// into its temporal dead zone, so the whole script threw
// `ReferenceError: Cannot access 'URL' before initialization` before doing
// anything at all.
const HARNESS_URL =
  process.env.HARNESS_URL ||
  "http://127.0.0.1:5193/verify-harness/mic-dialog.html";

const { port, cleanup } = await launch({ width: 1100, height: 1000 });
const page = await newPage(port);

const consoleErrors = [];
const pageErrors = [];
page.on("Runtime.consoleAPICalled", (p) => {
  if (p.type === "error")
    consoleErrors.push(
      p.args.map((a) => a.value ?? a.description ?? "").join(" "),
    );
});
page.on("Runtime.exceptionThrown", (p) =>
  pageErrors.push(p.exceptionDetails?.exception?.description ?? "exception"),
);

await page.send("Network.enable");
await page.setViewport(1100, 1000);
await page.goto(HARNESS_URL);
await sleep(7000);

const problems = [];
const note = (label, detail) => problems.push(`${label}: ${detail}`);

// ---- Structural probe -------------------------------------------------------
const probe = `(() => {
  const q = (sel) => document.querySelector(sel);
  const all = (sel) => Array.from(document.querySelectorAll(sel));
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; };
  const switches = all('input[type=checkbox]').map((input) => ({
    label: input.closest('.MuiFormControlLabel-root')?.textContent?.trim() ?? '',
    checked: input.checked,
    disabled: input.disabled,
    box: box(input.closest('.MuiFormControlLabel-root')),
    hit: box(input),
  }));
  return {
    title: document.querySelector('[role=dialog] h2, [role=dialog] h6')?.textContent ?? null,
    dialog: box(q('[role=dialog]')),
    switches,
    // MUI puts no explicit role on the slider; the visually hidden
    // input[type=range] carries the implicit role=slider, so that is what has
    // to be measured. Querying [role=slider] would report zero sliders on a
    // dialog that renders one.
    sliders: all('input[type=range]').map((s) => ({ value: s.getAttribute('aria-valuenow'),
      min: s.getAttribute('aria-valuemin'), max: s.getAttribute('aria-valuemax'),
      label: s.getAttribute('aria-label'), valuetext: s.getAttribute('aria-valuetext'),
      focusedByKeyboard: s.tabIndex, box: box(s), thumb: box(s.closest('.MuiSlider-thumb')) })),
    switchRoles: all('[role=switch]').map((s) => s.getAttribute('aria-checked')),
    text: (q('[role=dialog]')?.innerText ?? '').slice(0, 1500),
    buttons: all('[role=dialog] button').map((b) => ({ text: b.textContent?.trim().slice(0,40),
      disabled: b.disabled, box: box(b) })),
  };
})()`;

const state = await page.evaluate(probe);
writeFileSync(
  `${OUT}/mic-dialog-structure.json`,
  JSON.stringify(state, null, 2),
);

if (!state.dialog) note("render", "no [role=dialog] found at all");
if (state.dialog && state.dialog.w < 300)
  note("layout", `dialog is ${state.dialog.w}px wide`);

// The two switches this feature added.
const keep = state.switches.find((s) =>
  s.label.includes("Keep the microphone ready"),
);
const linger = state.switches.find((s) =>
  s.label.includes("Stay ready after a dictation"),
);
if (!keep) note("missing", "keep-ready switch not rendered");
if (!linger) note("missing", "linger switch not rendered");

// Hit-target size: the row is clickable, but the measured target should still be
// at least 24px tall (WCAG 2.5.8 candidate) and the input not zero-sized.
for (const s of state.switches) {
  if (s.box && s.box.h < 24)
    note("a11y", `switch row "${s.label}" is only ${s.box.h}px tall`);
}

// Every switch must expose a checkbox role and a name.
const unnamed = await page.evaluate(`(() => {
  return Array.from(document.querySelectorAll('input[type=checkbox]'))
    .filter((i) => !(i.getAttribute('aria-label') || i.closest('.MuiFormControlLabel-root')?.textContent?.trim()))
    .length;
})()`);
if (unnamed > 0) note("a11y", `${unnamed} switch(es) with no accessible name`);

// ---- Every descriptor has the shape the UI reads ---------------------------
//
// A field missing from `list_microphones` arrives as `undefined`, not as an
// error: the dialog once showed a device with no name because `name` was sent
// where `label` was expected, and the screenshots looked plausible. The
// `bluetooth` flag is new, and the keep-ready warning reads it, so its absence
// would silently disable that warning rather than fail.
const shape = await page.evaluate(`(async () => {
  const res = await window.__TAURI_INTERNALS__.invoke('list_microphones', {});
  return JSON.stringify(res.map((d) => ({
    keys: Object.keys(d).sort(),
    bluetoothIsBoolean: typeof d.bluetooth === 'boolean',
  })));
})()`);
const rows = JSON.parse(shape);
for (const row of rows) {
  if (!row.bluetoothIsBoolean)
    note(
      "shape",
      "a list_microphones descriptor is missing the bluetooth flag",
    );
}

// ---- Screenshot: default (keep off, no pre-roll after zero) -----------------
writeFileSync(`${OUT}/01-default.png`, await page.screenshot());

// ---- Contrast probe on the caption text ------------------------------------
const contrast = `(() => {
  const lum = (c) => { const [r,g,b] = c.match(/\\d+/g).map(Number).map((v) => {
      const s = v/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4);
    }); return 0.2126*r + 0.7152*g + 0.0722*b; };
  const bgOf = (el) => { let n = el; while (n) { const c = getComputedStyle(n).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; n = n.parentElement; }
    return 'rgb(255,255,255)'; };
  const out = [];
  for (const el of document.querySelectorAll('[role=dialog] *')) {
    if (!el.textContent?.trim() || el.children.length) continue;
    // Disabled controls are exempt from the contrast minimum, and a disabled
    // MUI button deliberately renders its label at the disabled colour.
    if (el.closest('[disabled], .Mui-disabled')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const size = parseFloat(cs.fontSize);
    const l1 = lum(cs.color), l2 = lum(bgOf(el));
    const ratio = (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
    out.push({ text: el.textContent.trim().slice(0,60), fontSize: size, ratio: +ratio.toFixed(2),
      bold: parseInt(cs.fontWeight,10) >= 600 });
  }
  return out;
})()`;
const contrastRows = await page.evaluate(contrast);
writeFileSync(`${OUT}/contrast.json`, JSON.stringify(contrastRows, null, 2));
for (const row of contrastRows) {
  const large = row.fontSize >= 24 || (row.fontSize >= 18.66 && row.bold);
  const min = large ? 3 : 4.5;
  if (row.ratio < min)
    note(
      "contrast",
      `"${row.text}" ${row.ratio}:1 at ${row.fontSize}px (needs ${min}:1)`,
    );
}

// ---- Interaction: turn keep-ready on ---------------------------------------
const toggledKeep = await page.evaluate(`(() => {
  const rows = Array.from(document.querySelectorAll('.MuiFormControlLabel-root'));
  const row = rows.find((r) => r.textContent.includes('Keep the microphone ready'));
  const input = row?.querySelector('input[type=checkbox]');
  if (!input) return 'no-switch';
  input.click();
  return 'clicked';
})()`);
await sleep(2500);
writeFileSync(`${OUT}/02-keep-on.png`, await page.screenshot());

const afterKeep = await page.evaluate(probe);
writeFileSync(
  `${OUT}/mic-dialog-keep-on.json`,
  JSON.stringify(afterKeep, null, 2),
);

if (!afterKeep.text.includes("Audio kept before the press"))
  note("ux", "pre-roll slider did not appear with keep-ready on");

// ---- The overridden linger switch: reachable, inert, and visibly so ---------
//
// Three separate failures have lived here, and only the third was visible on a
// screenshot:
//
//  1. `disabled` removed it from the tab order, so the caption explaining why it
//     is on was unreachable for a keyboard user.
//  2. Moving to `aria-disabled` fixed that and silently dropped the dimming that
//     `disabled` supplied, so an inert control looked operable.
//  3. The theme keys its checked styling on `.Mui-checked:not(.Mui-disabled)`,
//     so a disabled-but-checked switch rendered grey *unchecked* above a
//     caption saying "Already on".
//
// So all three are asserted, and a screenshot is still taken because a rule can
// pass every computed-style check and still look wrong.
const lingerState = await page.evaluate(`(() => {
  const rows = [...document.querySelectorAll('.MuiFormControlLabel-root')];
  const row = rows.find((r) => r.textContent.includes('Stay ready after a dictation'));
  if (!row) return null;
  const input = row.querySelector('input');
  const base = row.querySelector('.MuiSwitch-switchBase');
  const track = row.querySelector('.MuiSwitch-track');
  return {
    ariaDisabled: input.getAttribute('aria-disabled'),
    nativelyDisabled: input.disabled,
    tabIndex: input.tabIndex,
    checked: input.checked,
    baseOpacity: getComputedStyle(base).opacity,
    cursor: getComputedStyle(base).cursor,
    checkedClass: base.classList.contains('Mui-checked'),
    hasExplainCaption: row.parentElement.textContent.includes('Already on, because the microphone is kept ready'),
  };
})()`);
if (!lingerState) {
  note("a11y", "linger switch row vanished");
} else {
  if (lingerState.ariaDisabled !== "true")
    note(
      "a11y",
      `overridden linger switch has aria-disabled=${lingerState.ariaDisabled}`,
    );
  if (lingerState.nativelyDisabled)
    note(
      "a11y",
      "overridden linger switch is natively disabled and left the tab order",
    );
  if (lingerState.tabIndex < 0)
    note("a11y", "overridden linger switch is not focusable");
  if (!lingerState.checkedClass || !lingerState.checked)
    note("state", "overridden linger switch does not read as on");
  // 0.5 is the theme's disabled affordance; 1 means it looks operable.
  if (Number(lingerState.baseOpacity) > 0.75)
    note(
      "a11y",
      `inert linger switch is not visually dimmed (opacity ${lingerState.baseOpacity})`,
    );
  if (lingerState.cursor !== "not-allowed")
    note("a11y", `inert linger switch cursor is "${lingerState.cursor}"`);
  if (!lingerState.hasExplainCaption)
    note("a11y", "overridden linger switch has no caption saying why it is on");
}
writeFileSync(
  `${OUT}/mic-dialog-linger-overridden.json`,
  JSON.stringify(lingerState, null, 2),
);

// ---- Overflow: does the dialog scroll rather than clip ---------------------
const overflow = await page.evaluate(`(() => {
  const d = document.querySelector('.MuiDialog-paper, [role=dialog] > div');
  if (!d) return null;
  const r = d.getBoundingClientRect();
  return { scrollH: d.scrollHeight, clientH: d.clientHeight, boxH: Math.round(r.height),
    clipped: d.scrollHeight > d.clientHeight + 1 && getComputedStyle(d).overflowY === 'visible' };
})()`);
if (overflow?.clipped)
  note(
    "layout",
    `content ${overflow.scrollH}px in a ${overflow.clientH}px box with no scroll`,
  );

// ---- Horizontal cutoff at a narrow width ----------------------------------
await page.setViewport(560, 900);
await sleep(1200);
const narrow = await page.evaluate(`(() => {
  const d = document.querySelector('[role=dialog]');
  const off = Array.from(document.querySelectorAll('[role=dialog] *')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1);
  }).length;
  const r = d?.getBoundingClientRect();
  return { offscreenElements: off, dialogWidth: r ? Math.round(r.width) : null,
    viewport: window.innerWidth, docScrollW: document.documentElement.scrollWidth };
})()`);
writeFileSync(`${OUT}/narrow.json`, JSON.stringify(narrow, null, 2));
if (narrow.offscreenElements > 0)
  note(
    "layout",
    `${narrow.offscreenElements} element(s) outside the viewport at 560px`,
  );
if (narrow.docScrollW > narrow.viewport + 1)
  note(
    "layout",
    `page scrolls horizontally: ${narrow.docScrollW}px > ${narrow.viewport}px`,
  );
writeFileSync(`${OUT}/03-narrow-560.png`, await page.screenshot());

// ---- Scroll affordance -----------------------------------------------------
//
// The dialog is taller than a laptop's viewport. At 520 px the content is cut
// mid-sentence, and without a fade the cut reads as a rendering bug rather than
// as "there is more below". The fade is only correct when the content really
// does overflow, so both halves are checked: an overflowing short viewport must
// show the bottom fade, and a viewport tall enough to fit everything must show
// neither.
await page.setViewport(900, 520);
await sleep(900);
const shortFades = await page.evaluate(`(() => {
  const paper = document.querySelector('.MuiDialog-paper');
  const content = document.querySelector('.MuiDialogContent-root');
  if (!paper || !content) return null;
  const fades = [...paper.querySelectorAll('[aria-hidden]')].filter((el) => {
    const cs = getComputedStyle(el);
    return (
      cs.position === 'absolute' &&
      cs.pointerEvents === 'none' &&
      cs.backgroundImage.includes('gradient')
    );
  });
  return {
    count: fades.length,
    opacities: fades.map((el) => Number(getComputedStyle(el).opacity)),
    overflows: content.scrollHeight > content.clientHeight + 1,
  };
})()`);
writeFileSync(`${OUT}/scroll-fades.json`, JSON.stringify(shortFades, null, 2));
if (!shortFades) note("fades", "dialog or content missing at 520 px");
else {
  if (!shortFades.overflows)
    note(
      "fades",
      "content did not overflow at 520 px; the case is not exercised",
    );
  if (shortFades.count !== 2)
    note("fades", `expected 2 fade layers, found ${shortFades.count}`);
  // Bottom only: scrolled to the top, so nothing is hidden above.
  else if (shortFades.opacities[1] !== 1)
    note("fades", "bottom fade is not showing over clipped content");
  else if (shortFades.opacities[0] !== 0)
    note("fades", "top fade is showing while scrolled to the top");
}

// A property of the fade, not just its visibility: it has to let clicks through,
// or it would sit over the switches it is drawn above.
const fadeBlocksClicks = await page.evaluate(`(() => {
  const paper = document.querySelector('.MuiDialog-paper');
  const fade = [...paper.querySelectorAll('[aria-hidden]')].find((el) => {
    const cs = getComputedStyle(el);
    return cs.position === 'absolute' && cs.backgroundImage.includes('gradient');
  });
  return fade ? getComputedStyle(fade).pointerEvents !== 'none' : null;
})()`);
if (fadeBlocksClicks !== false)
  note("fades", "a fade would intercept pointer events");
writeFileSync(`${OUT}/05-scroll-fade.png`, await page.screenshot());

// ---- Dark mode -------------------------------------------------------------
// The theme's default mode is "system", so dark is reached by emulating the
// media query rather than by setting an attribute the theme never reads. The
// resulting background colour is reported, because a screenshot that looks
// light is otherwise indistinguishable from a screenshot that failed to load.
await page.setViewport(1100, 1000);
await page.send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "dark" }],
});
await sleep(1200);
const dark = await page.evaluate(`(() => {
  // Every lookup here can be absent when the dialog did not render, and a
  // crash would leave the run with no verdict at all. Report null instead so
  // the missing dialog surfaces as a problem, not as a stack trace.
  const bg = (sel) => { const el = document.querySelector(sel);
    return el ? getComputedStyle(el).backgroundColor : null; };
  const fg = (sel) => { const el = document.querySelector(sel);
    return el ? getComputedStyle(el).color : null; };
  return {
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    paperBg: bg('.MuiDialog-paper'),
    bodyBg: bg('body'),
    textColor: fg('[role=dialog] h2'),
  };
})()`);
writeFileSync(`${OUT}/dark.json`, JSON.stringify(dark, null, 2));
if (!dark.prefersDark) note("dark", "media emulation did not take effect");
if (!dark.paperBg) note("dark", "dialog paper not found in dark mode");
// The dark surface is near-black; a light paper here means the theme ignored
// the media query and the screenshot would misrepresent dark mode.
else if (dark.paperBg === "rgb(255, 255, 255)")
  note("dark", `dialog stayed light in dark mode (${dark.paperBg})`);
writeFileSync(`${OUT}/04-dark.png`, await page.screenshot());

// Restore, so a later probe in this file is not left in dark mode.
await page.send("Emulation.setEmulatedMedia", { features: [] });

console.log("DARK:", JSON.stringify(dark));

console.log(
  "STRUCTURE:",
  JSON.stringify({
    switches: state.switches.length,
    sliders: state.sliders.length,
    title: state.title,
  }),
);
console.log("TOGGLE:", toggledKeep);
console.log("NARROW:", JSON.stringify(narrow));
console.log("PROBLEMS:", JSON.stringify(problems, null, 2));
console.log("CONSOLE_ERRORS:", JSON.stringify(consoleErrors.slice(0, 8)));
const unmapped = await page.evaluate(`Array.from(window.__unhandled ?? [])`);
console.log("UNMAPPED_COMMANDS:", JSON.stringify(unmapped));
console.log("PAGE_ERRORS:", JSON.stringify(pageErrors.slice(0, 8)));

page.close();
cleanup();

// A probe that only prints is a probe nobody re-runs. Exit non-zero so this can
// gate a change, and keep the JSON artefacts for whoever has to explain a
// failure.
if (problems.length > 0 || pageErrors.length > 0 || consoleErrors.length > 0) {
  console.error(
    `\nFAILED: ${problems.length} problem(s), ` +
      `${pageErrors.length} page error(s), ${consoleErrors.length} console error(s)`,
  );
  process.exit(1);
}
if (unmapped.length > 0) {
  console.error(
    `\nFAILED: ${unmapped.length} native command(s) with no fake: ${unmapped.join(", ")}`,
  );
  process.exit(1);
}
console.log("\nPASS: dialog renders, measures and switches cleanly.");
