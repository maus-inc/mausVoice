// @vitest-environment jsdom
import { Dialog } from "@mui/material";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import {
  ensureUiHarness,
  setMatchMedia,
} from "../../../test/helpers/jsdom-ui-harness";
import { MenuPopoverBuilder, type MenuPopoverItem } from "./MenuPopover";

ensureUiHarness();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it.each(["primary", "end"] as const)(
  "opens a dialog after the %s menu action closes and restores its trigger",
  async (kind) => {
    setMatchMedia(false);
    let focusWhenOpened: Element | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const Harness = () => {
      const [dialog, setDialog] = useState(false);
      const openDialog = () => {
        focusWhenOpened = document.activeElement;
        setDialog(true);
      };
      const items: MenuPopoverItem[] = [
        {
          id: "edit",
          kind: "listItem",
          title: "Style",
          checked: true,
          onClick: ({ closeThen }) => closeThen(openDialog),
          endAction: ({ closeThen }) => (
            <button role="menuitem" onClick={() => closeThen(openDialog)}>
              Edit
            </button>
          ),
        },
      ];
      return (
        <MemoryRouter>
          <MenuPopoverBuilder items={items}>
            {({ ref, open, isOpen }) => (
              <button ref={ref} onClick={open} aria-expanded={isOpen}>
                Add Style
              </button>
            )}
          </MenuPopoverBuilder>
          <Dialog open={dialog}>
            <button onClick={() => setDialog(false)}>Close</button>
          </Dialog>
        </MemoryRouter>
      );
    };
    try {
      await act(async () => root.render(<Harness />));
      const trigger = host.querySelector("button")!;
      await act(async () => {
        trigger.focus();
        trigger.click();
        await wait(30);
      });
      const action = document.querySelector<HTMLElement>(
        kind === "primary" ? '[role="menuitemcheckbox"]' : '[role="menuitem"]',
      )!;
      await act(async () => {
        action.focus();
        action.click();
      });
      await act(async () => {
        await wait(500);
      });
      expect(focusWhenOpened).toBe(trigger);
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog).toBeTruthy();
      await act(async () => {
        dialog.querySelector("button")!.click();
        await wait(500);
      });
      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
