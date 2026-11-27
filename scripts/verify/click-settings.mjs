import assert from "node:assert/strict";
import { launch, newPage, sleep, waitForTruthy } from "./cdp.mjs";

const THEME = process.env.THEME || "light";
const BASE =
  process.env.HARNESS_URL ||
  "http://127.0.0.1:5193/verify-harness/settings.html";
const PAGES = [
  "home",
  "dictation",
  "ai-models",
  "shortcuts",
  "appearance",
  "privacy-data",
  "system",
  "account",
];
const browser = await launch();
const page = await newPage(browser.port);
const checks = [];

const waitFor = async (expression, message) => {
  const result = await waitForTruthy({
    evaluate: (expr) => page.evaluate(expr),
    expression,
  });
  assert.ok(result.ok, `Timed out waiting for ${message}`);
};
const open = async (id) => {
  await page.goto(`${BASE}?page=${id}&theme=${THEME}`);
  await waitFor("Boolean(document.querySelector('h1'))", `${id} heading`);
  await sleep(450);
};
const record = (name) => checks.push(name);
const clickLink = async (label, expectedPath) => {
  const path = await page.evaluate(`(() => {
    const link = [...document.querySelectorAll('a')].find((node) => node.textContent.trim() === ${JSON.stringify(label)});
    if (!link) throw new Error('Missing link: ' + ${JSON.stringify(label)});
    link.click();
    return link.getAttribute('href');
  })()`);
  assert.equal(path, expectedPath, `${label} href`);
  await waitFor(
    `document.querySelector('nav a[aria-current="page"]')?.getAttribute('href') === ${JSON.stringify(expectedPath)} && Boolean(document.querySelector('h1'))`,
    `${label} navigation`,
  );
  record(`link ${label} -> ${expectedPath}`);
};
const escape = async () => {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await sleep(150);
};

try {
  await open("home");
  for (const id of PAGES) {
    const title = await page.evaluate(
      `document.querySelector('h1')?.textContent.trim()`,
    );
    assert.ok(
      title,
      `Home route renders heading before rail navigation to ${id}`,
    );
    const label = await page.evaluate(
      `({home:'Overview',dictation:'Dictation','ai-models':'AI and models',shortcuts:'Shortcuts',appearance:'Appearance','privacy-data':'Privacy and data',system:'System',account:'Account'})[${JSON.stringify(id)}]`,
    );
    const route = `/dashboard/settings/${id}`;
    await clickLink(label, route);
    const active = await page.evaluate(
      `document.querySelector('nav a[aria-current="page"]')?.getAttribute('href')`,
    );
    assert.equal(active, route, `${id} active rail item`);
    record(`active rail item ${id}`);
  }

  await open("dictation");
  await page.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Search settings"]');
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'microphone');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(
    `Boolean([...document.querySelectorAll('button')].find((node) => node.textContent.toLowerCase().includes('microphone')))`,
    "search results",
  );
  const resultCount = await page.evaluate(
    `document.querySelectorAll('button').length`,
  );
  assert.ok(resultCount > 0, "search returns clickable results");
  await page.evaluate(`(() => {
    const hit = [...document.querySelectorAll('button')].find((node) => node.textContent.toLowerCase().includes('microphone'));
    hit.click();
  })()`);
  await waitFor(
    `document.querySelector('nav a[aria-current="page"]')?.getAttribute('href') === '/dashboard/settings/dictation' && Boolean(document.querySelector('#setting-microphone'))`,
    "search result destination",
  );
  record("search result opens microphone setting anchor");

  await page.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Search settings"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'zzzz-no-match');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(
    `document.body.innerText.includes('Nothing matches that search')`,
    "empty search state",
  );
  record("search empty state explains next action");

  await page.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Search settings"]');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('a')].find((node) => node.textContent.trim() === 'Dictation').focus();
  })()`);
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "/",
    code: "Slash",
    windowsVirtualKeyCode: 191,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "/",
    code: "Slash",
    windowsVirtualKeyCode: 191,
  });
  const searchFocused = await page.evaluate(
    `document.activeElement?.getAttribute('aria-label') === 'Search settings'`,
  );
  assert.ok(searchFocused, "slash shortcut focuses settings search");
  await page.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Search settings"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'microphone');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await escape();
  const queryCleared = await page.evaluate(
    `document.querySelector('input[aria-label="Search settings"]')?.value === ''`,
  );
  assert.ok(queryCleared, "Escape clears the search");
  record("slash focuses search and Escape clears it");

  await open("home");
  await clickLink("All shortcuts", "/dashboard/settings/shortcuts");
  await open("home");
  await clickLink("Manage models", "/dashboard/settings/ai-models");
  record("overview group actions navigate to their real pages");

  let switches = 0;
  let tabs = 0;
  for (const id of PAGES) {
    await open(id);
    for (const input of await page.evaluate(`([...document.querySelectorAll('input[role="switch"]:not(:disabled)')].map((node) => ({
      label: node.getAttribute('aria-labelledby'),
      checked: node.checked,
    })))`)) {
      assert.ok(input.label, `${id} switch has an accessible label`);
      assert.equal(
        typeof input.checked,
        "boolean",
        `${id} switch exposes state`,
      );
      switches++;
      record(`${id} switch ${input.label} exposes state and label`);
    }

    const tabStates =
      await page.evaluate(`([...document.querySelectorAll('button[role="tab"]:not(:disabled)')].map((node) => ({
      label: node.innerText.trim(),
      selected: node.getAttribute('aria-selected'),
    })))`);
    for (const tab of tabStates) {
      assert.ok(tab.label, `${id} tab has a visible label`);
      assert.ok(
        tab.selected === "true" || tab.selected === "false",
        `${id} tab exposes its selected state`,
      );
      tabs++;
    }
  }

  console.log(
    JSON.stringify(
      {
        theme: THEME,
        pageNavigations: 8,
        accessibleSwitches: switches,
        tabs,
        checks,
        result: "PASS",
      },
      null,
      2,
    ),
  );
} finally {
  page.close();
  browser.cleanup();
}
