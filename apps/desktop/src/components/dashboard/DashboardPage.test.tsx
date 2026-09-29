// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import type { Transcription } from "@maus-inc/types";
import { createRoot, type Root } from "react-dom/client";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

const historyEntry: Transcription = {
  id: "history-1",
  createdAt: "2026-09-25T12:00:00.000Z",
  createdByUserId: "user-1",
  transcript: "History entry",
  isDeleted: false,
};

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.0.0" }));
vi.mock("../../repos", () => ({
  getTranscriptionRepo: () => ({
    listTranscriptions: async () => [historyEntry],
  }),
}));
vi.mock("./DashboardMenu", () => ({
  DashboardMenu: () => (
    <nav>
      <Link to="/dashboard/dictionary">Dictionary tab</Link>
      <Link to="/dashboard/transcriptions">History tab</Link>
    </nav>
  ),
}));
vi.mock("./FeatureReleaseDialog", () => ({ FeatureReleaseDialog: () => null }));
vi.mock("./PermissionsDialog", () => ({ PermissionsDialog: () => null }));
vi.mock("../transcriptions/TranscriptionDetailsDialog", () => ({
  TranscriptionDetailsDialog: () => null,
}));

import DashboardPage from "./DashboardPage";
import { ScrollListPage } from "../common/ScrollListPage";
import { TranscriptionsSideEffects } from "../transcriptions/TranscriptionsSideEffects";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { getAppState, setAppState, useAppStore } from "../../store";

ensureUiHarness();
setMatchMedia(false);

let container: HTMLDivElement;
let root: Root;

// Mimic the dictionary's async list load without relying on a native repo.
function DictionaryList() {
  const title = "Dictionary";
  const [items, setItems] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) setItems(["Dictionary entry"]);
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section data-page={title}>
      <ScrollListPage
        title={title}
        items={items}
        renderItem={(item) => <p>{item}</p>}
      />
    </section>
  );
}

function HistoryList() {
  const ids = useAppStore((state) => state.transcriptions.transcriptionIds);
  return (
    <section data-page="History">
      <TranscriptionsSideEffects />
      <ScrollListPage
        title="History"
        items={ids}
        renderItem={(id) => (
          <p>{getAppState().transcriptionById[id]?.transcript}</p>
        )}
      />
      <Link to="?filter=today">Today</Link>
    </section>
  );
}

beforeEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
});

const clickTab = async (tab: "dictionary" | "transcriptions") => {
  const link = container.querySelector<HTMLAnchorElement>(
    `a[href="/dashboard/${tab}"]`,
  );
  if (!link) throw new Error(`Missing ${tab} link`);
  await act(async () => {
    link.click();
  });
};

const visiblePages = () =>
  Array.from(container.querySelectorAll("[data-page]"), (node) =>
    node.getAttribute("data-page"),
  );

describe("dashboard routing", () => {
  it("keeps exactly one live list through loads and navigation in both directions", async () => {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/dictionary"]}>
          <Routes>
            <Route path="/dashboard" element={<DashboardPage />}>
              <Route path="dictionary" element={<DictionaryList />} />
              <Route path="transcriptions" element={<HistoryList />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      ),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Dictionary entry"),
    );
    expect(visiblePages()).toEqual(["Dictionary"]);

    await clickTab("transcriptions");
    expect(visiblePages()).toEqual(["History"]);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("History entry"),
    );
    expect(visiblePages()).toEqual(["History"]);
    expect(container.textContent).not.toContain("Dictionary entry");

    await clickTab("dictionary");
    expect(visiblePages()).toEqual(["Dictionary"]);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Dictionary entry"),
    );
    expect(visiblePages()).toEqual(["Dictionary"]);
    expect(container.textContent).not.toContain("History entry");
  });

  it("does not let an outgoing History page clear the incoming list", async () => {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/dashboard/transcriptions"]}>
          <Routes>
            <Route path="/dashboard" element={<DashboardPage />}>
              <Route path="transcriptions" element={<HistoryList />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      ),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("History entry"),
    );
    expect(getAppState().transcriptions.transcriptionIds).toEqual([
      "history-1",
    ]);

    // React Router's old keyed exit animation mounted a second History page
    // for query-only navigation, then called the old instance's useOnExit
    // cleanup after the new instance had loaded. Advance that exit window
    // without a wall-clock sleep so the shared-store reset is observable.
    vi.useFakeTimers();
    const filterLink = container.querySelector<HTMLAnchorElement>(
      "a[href$='?filter=today']",
    );
    if (!filterLink) throw new Error("Missing filter link");
    act(() => filterLink.click());
    expect(visiblePages()).toEqual(["History"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(getAppState().transcriptions.transcriptionIds).toEqual([
      "history-1",
    ]);
    expect(container.textContent).toContain("History entry");
  });
});
