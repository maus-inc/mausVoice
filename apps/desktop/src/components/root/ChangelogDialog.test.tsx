// @vitest-environment jsdom
import { act, createElement } from "react";
import { IntlProvider } from "react-intl";
import de from "../../i18n/locales/de.json";
import { ChangelogFetchError } from "../../actions/changelog.actions";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchChangelogMock, openUrlMock, getVersionMock } = vi.hoisted(() => ({
  fetchChangelogMock: vi.fn(),
  openUrlMock: vi.fn(async () => undefined),
  getVersionMock: vi.fn(async () => "0.1.7"),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});

vi.mock("../../actions/changelog.actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../actions/changelog.actions")>()),
  fetchChangelog: fetchChangelogMock,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: openUrlMock,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: getVersionMock,
}));

import { ChangelogDialog } from "./ChangelogDialog";

import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

ensureUiHarness();

let container: HTMLDivElement;
let root: Root;

const entries = [
  {
    version: "0.1.7",
    tag: "mausVoice-v0.1.7",
    date: "2026-09-01T12:00:00Z",
    body: "Stable fixes.",
    prerelease: false,
    url: "https://github.com/maus-inc/mausVoice/releases/tag/mausVoice-v0.1.7",
  },
  {
    version: "0.2.0-rc.1",
    tag: "mausVoice-v0.2.0-rc.1",
    date: "2026-09-05T12:00:00Z",
    body: "Beta notes.",
    prerelease: true,
    url: "https://github.com/maus-inc/mausVoice/releases/tag/mausVoice-v0.2.0-rc.1",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  getVersionMock.mockResolvedValue("0.1.7");
  fetchChangelogMock.mockResolvedValue(entries);
  setMatchMedia(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const renderDialog = (locale = "en", messages: Record<string, string> = {}) => {
  act(() => {
    root.render(
      createElement(
        IntlProvider,
        { locale, messages, onError: () => {} },
        createElement(ChangelogDialog, { open: true, onClose: vi.fn() }),
      ),
    );
  });
};

const flush = async () => {
  await act(async () => {
    // Flush pending React effects and promise continuations.
  });
};

describe("ChangelogDialog", () => {
  it("handles an opener failure without navigating and allows retry", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fetchChangelogMock.mockResolvedValueOnce([
        { ...entries[0], body: "[Details](https://example.com/notes)" },
      ]);
      openUrlMock.mockRejectedValueOnce(new Error("opener unavailable"));
      renderDialog();
      await flush();
      const anchor = document.querySelector("a")!;
      await act(async () => anchor.click());
      expect(log).toHaveBeenCalledWith("Failed to open release-note link.");
      await act(async () => anchor.click());
      expect(openUrlMock).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });
  it.each(["https://example.com/notes", "http://example.com/notes"])(
    "opens Markdown %s in the external browser, never the webview",
    async (url) => {
      fetchChangelogMock.mockResolvedValueOnce([
        { ...entries[0], body: `[Details](${url})` },
      ]);
      renderDialog();
      await flush();
      const anchor = document.querySelector("a")!;
      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        anchor.dispatchEvent(click);
      });
      expect(click.defaultPrevented).toBe(true);
      expect(openUrlMock).toHaveBeenCalledWith(url);
    },
  );

  it.each([
    "file:///etc/passwd",
    "mailto:someone@example.com",
    "mausvoice://settings",
    "/relative/path",
  ])("does not make non-web release-note target %s actionable", async (url) => {
    fetchChangelogMock.mockResolvedValueOnce([
      { ...entries[0], body: `[Details](${url})` },
    ]);
    renderDialog();
    await flush();
    expect(document.body.textContent).toContain("Details");
    expect(document.querySelector("a")).toBeNull();
    expect(openUrlMock).not.toHaveBeenCalled();
  });
  it.each(["mausVoice-v0.1.7", "0.1.7", "MAUSVOICE_0.1.7"])(
    "marks the installed release for tag %s",
    async (tag) => {
      fetchChangelogMock.mockResolvedValueOnce([
        { ...entries[0], tag },
        entries[1],
      ]);
      renderDialog();
      await flush();

      expect(document.body.textContent).toContain("0.1.7");
      expect(document.body.textContent).toContain("0.2.0-rc.1");
      expect(document.body.textContent).toContain("Beta");
      expect(document.body.textContent).toContain("Stable");
      expect(document.body.textContent).toContain("Installed");
      expect(document.body.textContent).toContain("Stable fixes.");
    },
  );

  it("opens the release page externally", async () => {
    renderDialog();
    await flush();

    const link = Array.from(document.querySelectorAll("button")).find(
      (el) => el.textContent?.trim() === "View on GitHub",
    ) as HTMLElement;
    expect(link).toBeTruthy();
    await act(async () => {
      link.click();
    });
    expect(openUrlMock).toHaveBeenCalledWith(
      "https://github.com/maus-inc/mausVoice/releases/tag/mausVoice-v0.1.7",
    );
  });

  it("retries after a failure", async () => {
    fetchChangelogMock.mockRejectedValueOnce(new Error("nope"));
    renderDialog();
    await flush();

    expect(document.body.textContent).toContain(
      "Could not load the changelog.",
    );
    expect(document.body.textContent).not.toContain("nope");
    fetchChangelogMock.mockResolvedValueOnce(entries);
    await act(async () => {
      (
        Array.from(document.querySelectorAll("button")).find(
          (el) => el.textContent?.trim() === "Retry",
        ) as HTMLElement
      ).click();
    });
    await flush();
    expect(document.body.textContent).toContain("Stable fixes.");
  });

  it.each([
    [
      new ChangelogFetchError("network"),
      "Could not reach the release history.",
    ],
    [
      new ChangelogFetchError("http", 403),
      "The release history returned status 403.",
    ],
    [
      new ChangelogFetchError("invalid-response"),
      "The release history had an unexpected response.",
    ],
  ])("formats structured failure %s", async (error, message) => {
    fetchChangelogMock.mockRejectedValueOnce(error);
    renderDialog();
    await flush();
    expect(document.body.textContent).toContain(message);
    expect(document.body.textContent).not.toContain(error.message);
  });

  it("reformats an existing failure when the locale changes without fetching again", async () => {
    fetchChangelogMock.mockRejectedValueOnce(
      new ChangelogFetchError("network"),
    );
    renderDialog();
    await flush();
    expect(document.body.textContent).toContain(
      "Could not reach the release history.",
    );
    renderDialog("de", de);
    await flush();
    expect(document.body.textContent).toContain(
      de.could_not_reach_the_release_history,
    );
    expect(document.body.textContent).toContain(de.what_s_new);
    expect(fetchChangelogMock).toHaveBeenCalledOnce();
  });

  it("says so when there is no history", async () => {
    fetchChangelogMock.mockResolvedValue([]);
    renderDialog();
    await flush();

    expect(document.body.textContent).toContain("No releases found yet.");
  });
});

it("renders the Close button from the selected locale's real catalog", async () => {
  renderDialog("de", de);
  await flush();
  expect(
    Array.from(document.querySelectorAll("button")).some(
      (button) => button.textContent === de.close,
    ),
  ).toBe(true);
});
