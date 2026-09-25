// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Link, RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.0.0" }));
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

ensureUiHarness();
setMatchMedia(false);

let container: HTMLDivElement;
let root: Root;

// Both real pages initially render an empty list and replace it when their
// asynchronous repository load resolves. Exercise that transition in the
// actual dashboard shell, not just a static route with a text node.
function LoadedList({ title }: { title: string }) {
  const [items, setItems] = useState<string[]>([]);
  useEffect(() => {
    const id = setTimeout(() => setItems([`${title} entry`]), 0);
    return () => clearTimeout(id);
  }, [title]);
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

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const visiblePages = () =>
  Array.from(container.querySelectorAll("[data-page]"), (node) =>
    node.getAttribute("data-page"),
  );

describe("dashboard routing", () => {
  it("keeps exactly one live list through loads and navigation in both directions", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/dashboard",
          element: <DashboardPage />,
          children: [
            { path: "dictionary", element: <LoadedList title="Dictionary" /> },
            {
              path: "transcriptions",
              element: <LoadedList title="History" />,
            },
          ],
        },
      ],
      { initialEntries: ["/dashboard/dictionary"] },
    );
    try {
      await act(async () => root.render(<RouterProvider router={router} />));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(visiblePages()).toEqual(["Dictionary"]);
      expect(container.textContent).toContain("Dictionary entry");

      await act(async () => router.navigate("/dashboard/transcriptions"));
      expect(visiblePages()).toEqual(["History"]);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      expect(visiblePages()).toEqual(["History"]);
      expect(container.textContent).toContain("History entry");
      expect(container.textContent).not.toContain("Dictionary entry");

      await act(async () => router.navigate("/dashboard/dictionary"));
      expect(visiblePages()).toEqual(["Dictionary"]);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      expect(visiblePages()).toEqual(["Dictionary"]);
      expect(container.textContent).toContain("Dictionary entry");
      expect(container.textContent).not.toContain("History entry");
    } finally {
      router.dispose();
    }
  });

  it("does not remount the active page for a query-only navigation", async () => {
    let mounts = 0;
    let cleanups = 0;
    function Page() {
      useEffect(() => {
        mounts++;
        return () => {
          cleanups++;
        };
      }, []);
      return <div data-page="History">History entry</div>;
    }
    const router = createMemoryRouter(
      [
        {
          path: "/dashboard",
          element: <DashboardPage />,
          children: [{ path: "transcriptions", element: <Page /> }],
        },
      ],
      { initialEntries: ["/dashboard/transcriptions"] },
    );
    try {
      await act(async () => root.render(<RouterProvider router={router} />));
      await act(async () =>
        router.navigate("/dashboard/transcriptions?filter=today"),
      );
      expect(mounts).toBe(1);
      expect(visiblePages()).toEqual(["History"]);
      // History resets its shared list on unmount. An outgoing animated
      // Outlet used to run that cleanup after the incoming page had loaded.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      expect(cleanups).toBe(0);
      expect(visiblePages()).toEqual(["History"]);
    } finally {
      router.dispose();
    }
  });
});
