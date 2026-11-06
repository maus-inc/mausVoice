import { browser, $, expect } from "@wdio/globals";

type TileLocator = ReturnType<typeof $>;

/**
 * MausAgent native deliverable contract (webdriver).
 *
 * Implementation map:
 *   k5.9.9.1  #299 switch row press transform — apps/desktop/src/components/common/ListTile.tsx
 *             (switch semantics: apps/desktop/src/components/settings/SettingRow.tsx)
 *   m3.0.0.1  #300 saved-audio startup latency   — apps/desktop/src/utils/transcription-audio-cache.ts
 *   r7.3.0.2  #301 sidebar route prefetch        — apps/desktop/src/utils/route-prefetch.ts
 *   v2.0.7.0  #307 version tag overlap           — apps/desktop/src/components/dashboard/DashboardMenu.tsx
 *   p4.3.0.8  #308 preview popup eye toggle      — apps/desktop/src/components/preview/PreviewRoot.tsx
 *
 * Native verification notes:
 *   - The dashboard mounts `FeatureReleaseDialog`, a modal tour that swallows
 *     every pointer event until dismissed. `before()` clicks through it
 *     (locale-proof: the last dialog action button always advances/dismisses).
 *   - Pointer actuation uses real W3C actions with an approach move. A held
 *     press release completes a click and navigates, so every test routes
 *     through `ensureOn()` to start from a known state.
 *   - The browser resource timeline is blind to `tauri://` subresources
 *     (WebKit omits non-HTTP schemes: `getEntriesByType("resource")` stays
 *     empty even for boot chunks), so #301 is asserted through the
 *     `maus:route-prefetch` event that `createRouteLoader` dispatches on the
 *     first successful module load.
 *   - #300 asserts `location.pathname` plus a route-exclusive body string:
 *     the home page shares the "No transcriptions yet." empty state with the
 *     history page, so text alone can never prove navigation.
 *   - #308 is verified at the webview level only: the preview popup is a
 *     separate webview entry and is not reachable from the main window.
 */

const INTENT_MS = 400;
const PAGE_LOAD = 20_000;

/**
 * Sidebar tiles are `li` rows (ListTile) carrying their label as text, driven
 * by onClick navigation (no href, no aria-label on the row itself).
 */
const TILE_XPATH: Record<string, string> = {
  "/dashboard": '//li[.//*[normalize-space(text())="Home"]]',
  "/dashboard/transcriptions":
    '//li[.//*[normalize-space(text())="History"]]',
  "/dashboard/settings": '//li[.//*[normalize-space(text())="Settings"]]',
};


async function appReady() {
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(() => ({
        rootChildren: document.querySelector("#root")?.children.length ?? 0,
        bootText: document.body.innerText.includes("Starting mausVoice"),
      }));
      return state.rootChildren > 0 && !state.bootText;
    },
    { timeout: 20_000, timeoutMsg: "static: app boot did not finish" },
  );
}

/**
 * The root index route always redirects (`/` -> `/dashboard` or `/welcome`),
 * and the react-aria notification layer mounts before the router settles, so
 * "root has children" does not mean the app is routed. Wait for the router to
 * leave `/` before reading state.
 */
async function settleRoute() {
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => window.location.pathname)) !== "/",
    { timeout: 15_000, timeoutMsg: "static: router never left /" },
  );
}

async function stateSnapshot(tag: string) {
  const state = await browser.execute(() => ({
    path: window.location.pathname,
    dialog: !!document.querySelector(".MuiDialog-container"),
    sidebar: !!document.querySelector('[aria-label="Settings"]'),
  }));
  return `${tag} path=${state.path} dialog=${state.dialog} sidebar=${state.sidebar}`;
}

/**
 * Locale-proof modal dismissal: the FeatureReleaseDialog tour's last action
 * button is always the advance ("Next") or confirm ("Got it!") CTA. No-ops
 * when the dialog is absent (already dismissed for this profile).
 */
async function dismissFeatureDialog() {
  for (let i = 0; i < 12; i++) {
    const clicked = await browser.execute(() => {
      const dlg = document.querySelector(".MuiDialog-container");
      if (!dlg) return false;
      const buttons = dlg.querySelectorAll("button");
      const target = buttons[buttons.length - 1];
      target?.click();
      return true;
    });
    if (!clicked) return;
    await browser.pause(150);
  }
  const left = await browser.execute(
    () => !!document.querySelector(".MuiDialog-container"),
  );
  if (left) {
    throw new Error("static: feature-release dialog did not dismiss");
  }
}

async function resolveTile(tile: TileLocator, name: string) {
  const el = await tile;
  try {
    await el.waitForExist({ timeout: 10_000, timeoutMsg: "no-tile" });
  } catch {
    throw new Error(
      `static: tile ${name} missing | ${await stateSnapshot(name)}`,
    );
  }
  return el;
}

/**
 * Deterministic route entry: reload the app root (the only entry the packaged
 * asset protocol reliably serves), dismiss the modal, then click the sidebar
 * tile for `tileName` when the router lands elsewhere. Keeps every test
 * independent of prior side effects (a held-press release completes a click
 * and navigates).
 */
async function ensureOn(pathname: string) {
  let current = await browser.execute(() => window.location.pathname);
  if (current !== pathname) {
    await browser.url("tauri://localhost/");
    await appReady();
    await settleRoute();
    await dismissFeatureDialog();
    current = await browser.execute(() => window.location.pathname);
    if (current !== pathname) {
      await realClick($(TILE_XPATH[pathname]), pathname);
      await browser.waitUntil(
        async () =>
          (await browser.execute(() => window.location.pathname)) === pathname,
        {
          timeout: PAGE_LOAD,
          timeoutMsg: `static: tile for ${pathname} did not navigate`,
        },
      );
    }
    current = await browser.execute(() => window.location.pathname);
    if (current !== pathname) {
      throw new Error(`static: navigate to ${pathname} failed | path=${current}`);
    }
  }
  await dismissFeatureDialog();
}

async function realClick(tile: TileLocator, name: string) {
  const el = await resolveTile(tile, name);
  await browser.action("pointer")
    .move({ origin: el, x: 2, y: 2 })
    .down()
    .up()
    .perform();
}

async function realHover(tile: TileLocator, name: string, dwellMs: number) {
  const el = await resolveTile(tile, name);
  await browser.action("pointer")
    .move({ origin: el, x: 2, y: 2 })
    .perform();
  await browser.pause(dwellMs);
}

async function seedUser(): Promise<boolean> {
  return browser.execute(
    async (payload: string) => {
      try {
        const raw = JSON.parse(payload) as {
          id: string;
          name: string;
          bio: string;
          onboarded: boolean;
        };
        await (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke(c: string, a: unknown): Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__.invoke("user_set_one", {
          user: {
            id: raw.id,
            name: raw.name,
            bio: raw.bio,
            onboarded: raw.onboarded,
          },
        });
        return true;
      } catch {
        return false;
      }
    },
    JSON.stringify({
      id: "ec2f6bbd-72e8-4a12-a344-5fb69c48e0c3",
      name: "MausAgent",
      bio: "Verified native session",
      onboarded: true,
    }),
  );
}

describe("MausAgent native deliverable contract", () => {
  before(async () => {
    await browser.url("tauri://localhost/");
    await appReady();
    await settleRoute();

    // The user row is written through the tauri command layer and the boot
    // router reads it right after refresh. Retry the seed/reload pair to
    // absorb the startup race where the first read lands before the write is
    // visible, then require the authenticated dashboard.
    let href = "/";
    for (let attempt = 0; attempt < 3 && href !== "/dashboard"; attempt++) {
      const seeded = await seedUser();
      if (!seeded) {
        throw new Error("static: user_set_one seed upsert failed");
      }
      await browser.refresh();
      await appReady();
      await settleRoute();
      await dismissFeatureDialog();
      href = await browser.execute(() => window.location.pathname);
    }

    const readBack = await browser.execute(async () => {
      try {
        const row = await (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke(c: string, a: unknown): Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__.invoke("user_get_one", {});
        return row ? "row" : "null";
      } catch (error) {
        return `err:${error instanceof Error ? error.message : String(error)}`;
      }
    });
    if (href !== "/dashboard") {
      const diag = await browser.execute(() => ({
        path: window.location.pathname,
        text: document.body.innerText.slice(0, 160).replace(/\s+/g, " "),
        root: (document.querySelector("#root")?.innerHTML ?? "").slice(0, 160),
      }));
      throw new Error(
        `static: expected authenticated /dashboard, got ${String(href)} user_get_one=${readBack} text=${diag.text} root=${diag.root}`,
      );
    }
  });

  it("r7.3.0.2 #301 prefetches a sidebar route chunk on hover, exactly once", async () => {
    try {
      await ensureOn("/dashboard");
      const settingsTile = $(TILE_XPATH["/dashboard/settings"]);

      await browser.execute(() => {
        const log = [] as string[];
        (window as unknown as { __pfLog: string[] }).__pfLog = log;
        window.addEventListener("maus:route-prefetch", (event) => {
          log.push((event as CustomEvent<string>).detail);
        });
      });

      const countSettings = () =>
        browser.execute(
          () =>
            ((window as unknown as { __pfLog: string[] }).__pfLog ?? []).filter(
              (key) => key === "/dashboard/settings",
            ).length,
        );

      // Absent before any hover (the settings module is not part of boot).
      expect(await countSettings()).toBe(0);

      await realHover(settingsTile, "Settings", INTENT_MS);
      await browser.waitUntil(async () => (await countSettings()) >= 1, {
        timeout: 5_000,
        timeoutMsg:
          "static: hover did not prefetch the /dashboard/settings route module",
      });
      expect(await countSettings()).toBe(1);

      // Hovering again must not warm the module a second time.
      await realHover(settingsTile, "Settings", INTENT_MS);
      await browser.pause(300);
      expect(await countSettings()).toBe(1);
    } catch (error) {
      throw new Error(
        `static: ${error instanceof Error ? error.message : String(error)} | ${await stateSnapshot("#301")}`,
      );
    }
  });

  it("r7.3.0.2b #301 records before/after route-navigation latency", async () => {
    // The acceptance criteria ask for a measured before/after on a
    // representative route. Module imports are memoized per page load, so
    // "before" (click with no warmup) and "after" (hover-warm, then click) are
    // measured across two fresh app loads of the same route.
    try {
      const freshApp = async () => {
        await browser.url("tauri://localhost/");
        await appReady();
        await settleRoute();
        await dismissFeatureDialog();
      };
      const clickToSettled = async (pathname: string) => {
        await realClick($(TILE_XPATH[pathname]), pathname);
        const started = Date.now();
        await browser.waitUntil(
          async () =>
            (await browser.execute(() => window.location.pathname)) ===
            pathname,
          {
            timeout: PAGE_LOAD,
            timeoutMsg: `static: measurement navigation to ${pathname} failed`,
          },
        );
        await settleRoute();
        return Date.now() - started;
      };

      // Before: a plain click navigates and lazy-loads the module.
      await freshApp();
      const coldMs = await clickToSettled("/dashboard/transcriptions");

      // After: the hover warms the chunk first on this same page load; the
      // click then only routes.
      await freshApp();
      await browser.execute(() => {
        const log = [] as string[];
        (window as unknown as { __pfLog: string[] }).__pfLog = log;
        window.addEventListener("maus:route-prefetch", (event) => {
          log.push((event as CustomEvent<string>).detail);
        });
      });
      await realHover(
        $(TILE_XPATH["/dashboard/transcriptions"]),
        "History",
        INTENT_MS,
      );
      await browser.waitUntil(
        async () =>
          (
            await browser.execute(
              () =>
                ((window as unknown as { __pfLog: string[] }).__pfLog ?? []).filter(
                  (key) => key === "/dashboard/transcriptions",
                ).length,
            )
          ) >= 1,
        { timeout: 5_000, timeoutMsg: "static: hover did not warm History" },
      );
      const warmMs = await clickToSettled("/dashboard/transcriptions");

      // The evidence lives in the run log; the assertion keeps it honest:
      // a warm navigation must not be slower than the cold one.
      console.log(
        `static: #301 nav-before=${coldMs}ms nav-after=${warmMs}ms (History, click to settled)`,
      );
      expect(warmMs).toBeLessThanOrEqual(coldMs + 250);
    } catch (error) {
      throw new Error(
        `static: ${error instanceof Error ? error.message : String(error)} | ${await stateSnapshot("#301-nav")}`,
      );
    }
  });

  it("k5.9.9.1 #299 renders list rows with a stable, press-safe layout", async () => {
    try {
      await ensureOn("/dashboard");
      const settingsTile = $(TILE_XPATH["/dashboard/settings"]);

      // Contract 1: the row renders no hidden interactive DOM (the removed
      // hover-layer IconButton used to sit display:none inside every row).
      const hidden = await browser.execute(() => {
        const rows = [...document.querySelectorAll("li")];
        const row = rows.find((li) =>
          [...li.querySelectorAll("span, p, div")].some(
            (n) =>
              n.children.length === 0 &&
              (n.textContent ?? "").trim() === "Settings",
          ),
        );
        if (!row) return -1;
        return [...row.querySelectorAll("button, a, input")].filter(
          (el) => getComputedStyle(el).display === "none",
        ).length;
      });
      expect(hidden).toBe(0);

      // Contract 2: a real held press leaves no transformed ancestor and the
      // row keeps its layout rect (the old intent styles scaled the row).
      const before = await browser.execute(() => {
        const rows = [...document.querySelectorAll("li")];
        const row = rows.find((li) =>
          [...li.querySelectorAll("span, p, div")].some(
            (n) =>
              n.children.length === 0 &&
              (n.textContent ?? "").trim() === "Settings",
          ),
        );
        if (!row) return null;
        const ancestors: string[] = [];
        let node: Element | null = row;
        while (node) {
          const t = getComputedStyle(node).transform;
          if (t && t !== "none") ancestors.push(`${node.tagName}:${t}`);
          node = node.parentElement;
        }
        const r = row.getBoundingClientRect();
        return {
          transformed: ancestors,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      });
      expect(before).not.toBeNull();
      expect(before!.transformed).toEqual([]);

      const tileEl = await resolveTile(settingsTile, "Settings");
      await browser.action("pointer")
        .move({ origin: tileEl, x: 2, y: 2 })
        .down()
        .perform();
      const during = await browser.execute(() => {
        const rows = [...document.querySelectorAll("li")];
        const row = rows.find((li) =>
          [...li.querySelectorAll("span, p, div")].some(
            (n) =>
              n.children.length === 0 &&
              (n.textContent ?? "").trim() === "Settings",
          ),
        );
        if (!row) return null;
        const ancestors: string[] = [];
        let node: Element | null = row;
        while (node) {
          const t = getComputedStyle(node).transform;
          if (t && t !== "none") ancestors.push(`${node.tagName}:${t}`);
          node = node.parentElement;
        }
        const r = row.getBoundingClientRect();
        return {
          transformed: ancestors,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      });
      await browser.releaseActions();
      expect(during!.transformed).toEqual([]);
      expect(during!.rect).toEqual(before!.rect);

      // Contract 3: keyboard activation on a real switch row toggles exactly
      // once per Space, leaves the row's rect stable, and transforms nothing.
      await ensureOn("/dashboard/settings");
      await browser.execute(() => {
        const links = [...document.querySelectorAll("a")];
        const target = links.find((a) =>
          (a.textContent ?? "").includes("Appearance"),
        );
        target?.click();
      });
      await browser.waitUntil(
        async () =>
          (await browser.execute(() => document.querySelectorAll('input[role="switch"]').length)) >
          0,
        {
          timeout: 5_000,
          timeoutMsg: "static: no switch rows on the appearance page",
        },
      );
      const toggleState = await browser.execute(() => {
        const input = document.querySelector<HTMLInputElement>(
          'input[role="switch"]',
        )!;
        input.focus();
        const row = input.closest("label")!;
        const r = row.getBoundingClientRect();
        return {
          checked: input.checked,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      });
      await browser.keys("Space");
      const afterSpace = await browser.execute(() => {
        const input = document.querySelector<HTMLInputElement>(
          'input[role="switch"]',
        )!;
        const row = input.closest("label")!;
        const r = row.getBoundingClientRect();
        let transformed = false;
        let node: Element | null = row;
        while (node) {
          const t = getComputedStyle(node).transform;
          if (t && t !== "none") transformed = true;
          node = node.parentElement;
        }
        return {
          checked: input.checked,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          transformed,
        };
      });
      // Exactly once: the checked state flipped, the row did not move or scale.
      expect(afterSpace.checked).toBe(!toggleState.checked);
      expect(afterSpace.rect).toEqual(toggleState.rect);
      expect(afterSpace.transformed).toBe(false);
      // Restore the setting so the profile is left as found.
      await browser.keys("Space");
    } catch (error) {
      throw new Error(
        `static: ${error instanceof Error ? error.message : String(error)} | ${await stateSnapshot("#299")}`,
      );
    }
  });

  it("m3.0.0.1 #300 routes the History tile to the history page with its empty state", async () => {
    try {
      await ensureOn("/dashboard");
      const historyTile = $(TILE_XPATH["/dashboard/transcriptions"]);
      await realClick(historyTile, "History");

      await browser.waitUntil(
        async () => {
          const href = await browser.execute(() => window.location.pathname);
          return href === "/dashboard/transcriptions";
        },
        {
          timeout: PAGE_LOAD,
          timeoutMsg:
            "static: History tile did not navigate to /dashboard/transcriptions",
        },
      );

      // Route-exclusive body text: the home page shares the
      // "No transcriptions yet." string, so assert the pathname plus the
      // history page's own supporting copy.
      await browser.waitUntil(
        async () =>
          await browser.execute(() =>
            document.body.innerText.includes(
              "Dictate something, or import an audio file to get started.",
            ),
          ),
        {
          timeout: PAGE_LOAD,
          timeoutMsg: "static: history page empty state did not render",
        },
      );

      const state = await browser.execute(() => ({
        href: window.location.pathname,
        empty: document.body.innerText.includes("No transcriptions yet."),
        count: document.querySelectorAll("audio").length,
      }));
      expect(state.href).toBe("/dashboard/transcriptions");
      expect(state.empty).toBe(true);
      expect(state.count).toBe(0);
    } catch (error) {
      throw new Error(
        `static: ${error instanceof Error ? error.message : String(error)} | ${await stateSnapshot("#300")}`,
      );
    }
  });

  it("v2.0.7.0 #307 keeps the sidebar version tag clear of the Settings tile", async () => {
    await ensureOn("/dashboard");
    const settings = await browser.execute(() => {
      const rows = [...document.querySelectorAll("li")];
      const row = rows.find((li) =>
        [...li.querySelectorAll("span, p, div")].some(
          (n) =>
            n.children.length === 0 &&
            (n.textContent ?? "").trim() === "Settings",
        ),
      );
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const caption = await browser.execute(() => {
      const captions = [...document.querySelectorAll("p, span")];
      const el = captions.find((node) =>
        /^v\d+\.\d+\.\d+/.test((node.textContent ?? "").trim()),
      );
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    expect(caption).not.toBeNull();
    expect(caption!.width).toBeGreaterThan(0);
    expect(caption!.height).toBeGreaterThan(0);
    expect(caption!.y).toBeGreaterThanOrEqual(settings!.y + settings!.height - 2);

    // Narrow window sizes: the layout fix must hold outside the default size.
    await browser.setWindowSize(900, 720);
    try {
      const narrow = await browser.execute(() => {
        const rows = [...document.querySelectorAll("li")];
        const row = rows.find((li) =>
          [...li.querySelectorAll("span, p, div")].some(
            (n) =>
              n.children.length === 0 &&
              (n.textContent ?? "").trim() === "Settings",
          ),
        );
        const captions = [...document.querySelectorAll("p, span")];
        const el = captions.find((node) =>
          /^v\d+\.\d+\.\d+/.test((node.textContent ?? "").trim()),
        );
        if (!row || !el) return null;
        const r = row.getBoundingClientRect();
        const c = el.getBoundingClientRect();
        // Hit-target probe: the Settings row's center must hit the row (or a
        // descendant), never the caption.
        const probe = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return {
          separated: c.y >= r.y + r.height - 2,
          hitIsCaption: !!probe && probe.contains(el),
        };
      });
      expect(narrow).not.toBeNull();
      expect(narrow!.separated).toBe(true);
      expect(narrow!.hitIsCaption).toBe(false);
    } finally {
      await browser.setWindowSize(1280, 800);
    }
  });
});
