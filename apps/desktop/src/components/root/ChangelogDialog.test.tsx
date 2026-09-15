// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchChangelogMock, openUrlMock, getVersionMock } = vi.hoisted(() => ({
  fetchChangelogMock: vi.fn(),
  openUrlMock: vi.fn(async () => undefined),
  getVersionMock: vi.fn(async () => "0.1.7"),
}));

vi.mock("react-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-intl")>();
  return {
    ...actual,
    useIntl: () => ({
      formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
        defaultMessage,
    }),
    FormattedMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  };
});

vi.mock("../../actions/changelog.actions", () => ({
  fetchChangelog: fetchChangelogMock,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: openUrlMock,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: getVersionMock,
}));

import { ChangelogDialog } from "./ChangelogDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver or matchMedia; MUI needs both.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const setMatchMedia = (matches: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};

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

const renderDialog = () => {
  act(() => {
    root.render(
      createElement(ChangelogDialog, { open: true, onClose: () => {} }),
    );
  });
};

const flush = async () => {
  await act(async () => {});
};

describe("ChangelogDialog", () => {
  it("lists releases with channel badges and marks the installed one", async () => {
    renderDialog();
    await flush();

    expect(document.body.textContent).toContain("0.1.7");
    expect(document.body.textContent).toContain("0.2.0-rc.1");
    expect(document.body.textContent).toContain("Beta");
    expect(document.body.textContent).toContain("Stable");
    expect(document.body.textContent).toContain("Installed");
    expect(document.body.textContent).toContain("Stable fixes.");
  });

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

    expect(document.body.textContent).toContain("nope");
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

  it("says so when there is no history", async () => {
    fetchChangelogMock.mockResolvedValue([]);
    renderDialog();
    await flush();

    expect(document.body.textContent).toContain("No releases found yet.");
  });
});
