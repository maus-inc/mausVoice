// Interactive click-through and keyboard probe for HelpPage and live TipCard
// across both light and dark themes in headless Chromium.
import { launch, newPage, sleep, waitForTruthy } from "./cdp.mjs";
import { watchPage } from "./page-watch.mjs";

const HARNESS_BASE =
  process.env.HARNESS_URL || "http://127.0.0.1:5193/verify-harness/help.html";

const ASSISTANT_EXPECTATIONS = {
  off: {
    label: "Open settings",
    route: "/dashboard/settings/ai-models#setting-assistant_mode",
  },
  on: {
    label: "Open chat",
    route: "/dashboard/chats",
  },
};

const failures = [];
const check = (label, ok, detail = "") => {
  const suffix = detail ? `: ${detail}` : "";
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${suffix}`);
  if (!ok) failures.push(`${label}${suffix}`);
};

const waitForCards = (page, selector, count) =>
  waitForTruthy({
    evaluate: (expr) => page.evaluate(expr),
    expression: `document.querySelectorAll('${selector}').length === ${count}`,
    timeoutMs: 30_000,
  });

const isRestored = (before, after) =>
  [
    before.hadButton,
    before.borderBefore === "dashed",
    after.borderAfter === "solid",
    !after.stillHasShowAgain,
    after.dashed === 1,
  ].every(Boolean);

const verifyShowAgain = async (page, theme) => {
  await page.goto(
    `${HARNESS_BASE}?view=help&theme=${theme}&dismissed=writing-styles,update-channel`,
  );
  await waitForCards(page, '[data-tip-frame="true"]', 5);
  await sleep(250);

  const before = await page.evaluate(`(() => {
    const frames = Array.from(document.querySelectorAll('[data-tip-frame="true"]'));
    const target = frames.find((f) => f.textContent?.startsWith("Teach mausVoice how you write"));
    const btn = Array.from(target?.querySelectorAll("button") ?? []).find((b) => b.textContent?.trim() === "Show again");
    const borderBefore = target ? getComputedStyle(target).borderTopStyle : null;
    btn?.click();
    return { hadButton: Boolean(btn), borderBefore };
  })()`);
  await sleep(200);

  const after = await page.evaluate(`(() => {
    const frames = Array.from(document.querySelectorAll('[data-tip-frame="true"]'));
    const target = frames.find((f) => f.textContent?.startsWith("Teach mausVoice how you write"));
    const stillHasShowAgain = Array.from(target?.querySelectorAll("button") ?? []).some((b) => b.textContent?.trim() === "Show again");
    const dashed = frames.filter((f) => getComputedStyle(f).borderTopStyle === "dashed").length;
    return { borderAfter: target ? getComputedStyle(target).borderTopStyle : null, stillHasShowAgain, dashed };
  })()`);

  check(
    `[${theme}] Show again restores dismissed card`,
    isRestored(before, after),
    JSON.stringify({ before, after }),
  );
};

const verifyAssistantAction = async (page, theme, mode) => {
  await page.goto(`${HARNESS_BASE}?view=help&theme=${theme}&assistant=${mode}`);
  await waitForCards(page, '[data-tip-frame="true"]', 5);
  await sleep(250);

  const label = await page.evaluate(`(() => {
    const frames = Array.from(document.querySelectorAll('[data-tip-frame="true"]'));
    const card = frames.find((f) => f.textContent?.startsWith("Talk to the assistant"));
    const btn = card?.querySelector("button");
    const text = btn?.textContent?.trim() ?? "";
    btn?.click();
    return text;
  })()`);
  await waitForTruthy({
    evaluate: (expr) => page.evaluate(expr),
    expression: "Boolean(document.querySelector('[data-route-landed]'))",
    timeoutMs: 10_000,
  });
  const landed = await page.evaluate(
    "document.querySelector('[data-route-landed]')?.getAttribute('data-route-landed')",
  );

  const expected = ASSISTANT_EXPECTATIONS[mode];
  check(
    `[${theme}] Assistant tip (${mode}) routes correctly`,
    label === expected.label && landed === expected.route,
    `label=${label} route=${landed}`,
  );
};

const verifyLiveTips = async (page, theme) => {
  await page.goto(`${HARNESS_BASE}?view=live-tip&theme=${theme}`);
  await waitForCards(page, '[data-tip-card="true"]', 2);
  await sleep(250);

  await page.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Add API key");
    btn?.click();
  })()`);
  await sleep(200);
  const liveState = await page.evaluate(`({
    clicks: (window.__TIP_LIVE_ACTION_CLICKS__ ?? []).length,
    cards: document.querySelectorAll('[data-tip-card="true"]').length,
  })`);
  check(
    `[${theme}] Live TipCard action fires without dismissing`,
    liveState.clicks === 1 && liveState.cards === 2,
    JSON.stringify(liveState),
  );

  await page.evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-tip-card="true"]'));
    const target = cards.find((c) => c.textContent?.includes("Review before it inserts"));
    const row = target?.querySelector('[data-tip-frame="true"]');
    row?.focus();
    row?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  })()`);
  const exited = await waitForCards(page, '[data-tip-card="true"]', 1);
  check(`[${theme}] Actionless live TipCard dismisses via keyboard`, exited.ok);
};

const runClickProbe = async () => {
  const browser = await launch({ width: 1100, height: 700 });
  const page = await newPage(browser.port);
  const { consoleErrors } = watchPage(page);
  await page.send("Network.enable");
  await page.setViewport(1100, 700);

  for (const theme of ["light", "dark"]) {
    await verifyShowAgain(page, theme);
    await verifyAssistantAction(page, theme, "off");
    await verifyAssistantAction(page, theme, "on");
    await verifyLiveTips(page, theme);
  }

  check(
    "Zero console errors",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors),
  );
  page.close();
  browser.cleanup();
};

await runClickProbe();
if (failures.length > 0) {
  process.exitCode = 1;
}
