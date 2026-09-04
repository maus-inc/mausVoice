// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@mui/material/styles";
import type { Conversation } from "@maus-inc/types";
import { theme } from "../../theme";

vi.mock("../common/MenuPopover", () => ({
  MenuPopoverBuilder: () => null,
  MenuPopoverItem: {} as never,
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

import { ConversationListItem } from "./ConversationListItem";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const parseColor = (value: string): number[] => {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match?.[1]) {
    throw new Error(`unparseable color: ${value}`);
  }
  return match[1].split(",").map((part) => Number.parseFloat(part.trim()));
};

const relativeLuminance = ([r, g, b]: number[]) => {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (foreground: number[], background: number[]) => {
  const foregroundAlpha = foreground[3] ?? 1;
  const blended = foreground
    .slice(0, 3)
    .map(
      (channel, index) =>
        foregroundAlpha * channel +
        (1 - foregroundAlpha) * (background[index] ?? 0),
    );
  const lightness = [
    relativeLuminance(blended),
    relativeLuminance(background.slice(0, 3)),
  ];
  return (Math.max(...lightness) + 0.05) / (Math.min(...lightness) + 0.05);
};

const sampleConversation: Conversation = {
  id: "conv-1",
  title: "My conversation",
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-01T12:00:00.000Z",
} as unknown as Conversation;

const noop = () => undefined;

type MountedRow = {
  container: HTMLDivElement;
  render: (options?: { selected?: boolean; themed?: boolean }) => Promise<void>;
  cleanup: () => void;
};

const mountRow = (handlers?: {
  onSelect?: () => void;
  onDelete?: () => void;
}): MountedRow => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const render = ({
    selected = false,
    themed = false,
  }: { selected?: boolean; themed?: boolean } = {}) => {
    const row = createElement(ConversationListItem, {
      conversation: sampleConversation,
      selected,
      onSelect: handlers?.onSelect ?? noop,
      onDelete: handlers?.onDelete ?? noop,
    });
    // Rendering the row is synchronous. A returned promise keeps the await
    // in callers meaningful.
    act(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          themed ? createElement(ThemeProvider, { theme }, row) : row,
        ),
      );
    });
    return Promise.resolve();
  };

  return {
    container,
    render,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

describe("ConversationListItem context menu", () => {
  const onDelete = vi.fn();
  let row: MountedRow | null = null;

  afterEach(() => {
    row?.cleanup();
    row = null;
    onDelete.mockClear();
  });

  const openMenu = async () => {
    row = mountRow({ onDelete });
    await row.render();
    const rowEl = row.container.querySelector<HTMLElement>(
      ".MuiListItemButton-root",
    );
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 50,
      clientY: 50,
    });
    act(() => {
      rowEl?.dispatchEvent(event);
    });
    return document.querySelector('[role="menu"]');
  };

  it("opens a context menu with only Delete conversation (no rename entry point exists)", async () => {
    const menu = await openMenu();
    expect(menu).not.toBeNull();
    const labels = Array.from(
      menu?.querySelectorAll('[role="menuitem"]') ?? [],
    ).map((el) => el.textContent ?? "");
    expect(labels).toEqual(["Delete conversation"]);
  });

  it("calls onDelete when Delete conversation is clicked", async () => {
    const menu = await openMenu();
    const deleteItem = Array.from(
      menu?.querySelectorAll('[role="menuitem"]') ?? [],
    ).find((el) => el.textContent === "Delete conversation") as
      HTMLElement | undefined;
    expect(deleteItem).toBeTruthy();

    await act(async () => {
      deleteItem?.click();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("ConversationListItem title and timestamp", () => {
  let row: MountedRow | null = null;

  afterEach(() => {
    row?.cleanup();
    row = null;
  });

  const timestampSpans = (container: HTMLElement) => {
    const spans = Array.from(
      container.querySelectorAll(".MuiListItemText-secondary span span"),
    );
    return { date: spans[0] ?? null, time: spans[1] ?? null };
  };

  const isHidden = (element: Element | null | undefined) =>
    element?.getAttribute("aria-hidden") === "true";

  it.each([false, true])(
    "renders the title and both timestamp states through ListItemText slots when selected is %s",
    async (selected) => {
      row = mountRow();
      await row.render({ selected });
      // Regression guard for the light-mode bug where the timestamp turned
      // invisible on the selected row. The theme only re-colors
      // `.MuiListItemText-secondary` on selection, so the timestamp must live
      // in that slot for every row state.
      const primary = row.container.querySelector(".MuiListItemText-primary");
      const { date, time } = timestampSpans(row.container);
      expect(primary?.textContent).toBe("My conversation");
      expect(date?.textContent).toBe("date");
      expect(time?.textContent).toBe("time");
      // The row rests on the date. Selection reveals the time.
      expect(isHidden(date)).toBe(selected);
      expect(isHidden(time)).toBe(!selected);
    },
  );

  it("reveals the time on hover and returns to the date on leave", async () => {
    row = mountRow();
    await row.render({ selected: false });
    const { date, time } = timestampSpans(row.container);
    expect(isHidden(time)).toBe(true);

    const button = row.container.querySelector(".MuiListItemButton-root");
    act(() => {
      button?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(isHidden(time)).toBe(false);
    expect(isHidden(date)).toBe(true);

    act(() => {
      button?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(isHidden(time)).toBe(true);
    expect(isHidden(date)).toBe(false);
  });

  it("drops the slide and the fade under reduced motion", async () => {
    row = mountRow();
    await row.render({ selected: false });

    // The crossfade ships a reduced-motion rule so the swap stays instant
    // for users who turn animations off. Emotion emits it with the caption
    // styles, so assert on the emitted CSS text.
    const css = Array.from(document.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    const at = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(
      at,
      "no reduced-motion rule in the emitted styles",
    ).toBeGreaterThanOrEqual(0);
    const block = css.slice(at, at + 200);
    expect(block).toMatch(/transform:\s*none/);
    expect(block).toMatch(/transition:\s*none/);
  });

  it("keeps the timestamp readable on the inverted selected background", async () => {
    // Second regression guard for the light-mode bug, at the theme level. A
    // selected row inverts to the near-black inkSolid.base background, so the
    // theme must re-color the timestamp slot. text.secondary stays dark there
    // and renders at 1 to 1 contrast, which reads as invisible.
    row = mountRow();
    await row.render({ selected: true, themed: true });

    const css = Array.from(document.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    const rule = css.match(
      /\.Mui-selected[^{]*\.MuiListItemText-secondary\{([^}]*)\}/,
    );
    expect(rule, "no selected-state rule for the timestamp slot").toBeTruthy();

    const colorDeclaration = (rule?.[1] ?? "").match(/color:\s*([^;]+);/);
    expect(colorDeclaration).toBeTruthy();
    const color = parseColor(colorDeclaration?.[1] ?? "");

    // inkSolid.base, hex 1A1712, is the selected-row background in light mode.
    expect(contrastRatio(color, [0x1a, 0x17, 0x12])).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});
