// Interactive click-through, keyboard focus-walk, target-size, and
// viewport-stress probe for HelpPage and live TipCard across both themes.
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

const assertThemeApplied = async (page, theme, context) => {
  const actual = await page.evaluate(
    'document.documentElement.getAttribute("data-mui-color-scheme")',
  );
  check(
    `[${theme}] Theme applied (${context})`,
    actual === theme,
    `actual=${actual}`,
  );
};

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
  await assertThemeApplied(page, theme, "help");

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
  await assertThemeApplied(page, theme, "live-tip");

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

const pressTab = async (page) => {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  });
};

const verifyTargets = async (page, theme) => {
  const targets = await page.evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll("main button"));
    const boxes = buttons.map((b) => {
      const r = b.getBoundingClientRect();
      return { text: b.textContent?.trim() ?? "", w: Math.round(r.width), h: Math.round(r.height) };
    });
    const minH = Math.min(...boxes.map((b) => b.h));
    const minW = Math.min(...boxes.map((b) => b.w));
    const unlabeled = boxes.filter((b) => !b.text).length;
    return { count: boxes.length, minW, minH, unlabeled };
  })()`);
  check(
    `[${theme}] Help action targets meet >=32px height and have names`,
    targets.count === 7 && targets.minH >= 32 && targets.unlabeled === 0,
    JSON.stringify(targets),
  );
};

const readActiveMainButton = (page) =>
  page.evaluate(`(() => {
    const el = document.activeElement;
    if (!el || !document.querySelector("main")?.contains(el)) return null;
    return {
      tag: el.tagName,
      text: (el.textContent || el.getAttribute("aria-label") || "").trim(),
      focusVisible: el.matches(":focus-visible"),
    };
  })()`);

const collectFocusTrail = async (page, targetCount) => {
  const seen = [];
  for (let i = 0; i < 30; i += 1) {
    await pressTab(page);
    const active = await readActiveMainButton(page);
    if (active) seen.push(active);
    if (seen.length === targetCount) return seen;
  }
  return seen;
};

const verifyFocusWalk = async (page, theme) => {
  await page.evaluate('document.querySelector("main")?.focus();');
  const seen = await collectFocusTrail(page, 7);
  const allVisible = seen.every((item) => item.focusVisible);
  check(
    `[${theme}] Keyboard Tab walk reaches all 7 Help buttons with :focus-visible`,
    seen.length === 7 && allVisible,
    `reached=${seen.length} focusVisible=${allVisible}`,
  );
};

const verifyFocusAndTargets = async (page, theme) => {
  await page.setViewport(1100, 700);
  await page.goto(
    `${HARNESS_BASE}?view=help&theme=${theme}&dismissed=writing-styles,update-channel`,
  );
  await waitForCards(page, '[data-tip-frame="true"]', 5);
  await sleep(250);
  await verifyTargets(page, theme);
  await verifyFocusWalk(page, theme);
};

const verifyViewportStressAndRtl = async (page, theme) => {
  await page.setViewport(320, 700);
  await page.goto(
    `${HARNESS_BASE}?view=help&theme=${theme}&dismissed=writing-styles,update-channel`,
  );
  await waitForCards(page, '[data-tip-frame="true"]', 5);
  await sleep(250);

  const stress = await page.evaluate(`(() => {
    const main = document.querySelector("main");
    const clipped = () =>
      Array.from(document.querySelectorAll("main *")).filter((el) => {
        if (!el.firstChild || el.firstChild.nodeType !== Node.TEXT_NODE) return false;
        const s = getComputedStyle(el);
        const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
        const hidden = s.overflow === "hidden" || s.overflowX === "hidden" || s.overflowY === "hidden";
        const affordance = s.textOverflow === "ellipsis" || s.webkitLineClamp !== "none";
        return cut && hidden && !affordance;
      }).length;
    const baseOverflow = Math.max(
      document.documentElement.scrollWidth - window.innerWidth,
      main ? main.scrollWidth - main.clientWidth : 0,
    );
    const baseClipped = clipped();

    document.documentElement.dir = "rtl";
    const rtlOverflow = Math.max(
      document.documentElement.scrollWidth - window.innerWidth,
      main ? main.scrollWidth - main.clientWidth : 0,
    );
    document.documentElement.dir = "ltr";

    const walker = document.createTreeWalker(main ?? document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.nodeValue?.trim()) node.nodeValue = node.nodeValue.trim().repeat(3);
    }
    const tripledOverflow = Math.max(
      document.documentElement.scrollWidth - window.innerWidth,
      main ? main.scrollWidth - main.clientWidth : 0,
    );
    return { baseOverflow, baseClipped, rtlOverflow, tripledOverflow };
  })()`);

  const ok =
    stress.baseOverflow <= 0 &&
    stress.baseClipped === 0 &&
    stress.rtlOverflow <= 0 &&
    stress.tripledOverflow <= 0;
  check(
    `[${theme}] 320px reflow, clipped-text, RTL, and 3x long-content stress`,
    ok,
    JSON.stringify(stress),
  );
};

const runClickProbe = async () => {
  const browser = await launch({ width: 1100, height: 700 });
  let page;
  try {
    page = await newPage(browser.port);
    const { consoleErrors, unexpectedFailedRequests } = watchPage(page);
    await page.send("Network.enable");

    for (const theme of ["light", "dark"]) {
      await page.setViewport(1100, 700);
      await verifyShowAgain(page, theme);
      await verifyAssistantAction(page, theme, "off");
      await verifyAssistantAction(page, theme, "on");
      await verifyLiveTips(page, theme);
      await verifyFocusAndTargets(page, theme);
      await verifyViewportStressAndRtl(page, theme);
    }

    check(
      "Zero console errors",
      consoleErrors.length === 0,
      JSON.stringify(consoleErrors),
    );
    check(
      "Zero unexpected failed requests",
      unexpectedFailedRequests.length === 0,
      JSON.stringify(unexpectedFailedRequests),
    );
  } finally {
    page?.close();
    browser.cleanup();
  }
};

await runClickProbe();
if (failures.length > 0) {
  process.exitCode = 1;
}
