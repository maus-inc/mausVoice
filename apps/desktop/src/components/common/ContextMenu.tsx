/** App-wide clipboard menu; surfaces can also create their own context menus. */
import {
  ClipboardCopy,
  ClipboardPaste,
  Scissors,
  SquareDashedMousePointer,
} from "lucide-react";
import { useEffect } from "react";
import { useIntl } from "react-intl";
import { useContextMenu } from "./useContextMenu";

export { ContextMenu } from "./ContextMenuSurface";
export type {
  ContextMenuActionItem,
  ContextMenuDivider,
  ContextMenuItem,
} from "./ContextMenuSurface";
export { useContextMenu } from "./useContextMenu";
export type { UseContextMenuReturn } from "./useContextMenu";

/**
 * The editable element a right-click acted on, plus its captured selection.
 * Captured at `contextmenu` time because the menu's `autoFocus` steals focus,
 * and `window.getSelection()` does NOT reflect `<input>`/`<textarea>`
 * selections (those live in `selectionStart`/`selectionEnd`).
 */
type EditableTarget = {
  el: HTMLElement;
  /** Selected text ("" when nothing selected). */
  text: string;
  /** Input/textarea selection bounds (only meaningful for inputs). */
  start: number;
  end: number;
  /** contenteditable selection snapshot (null for inputs). */
  range: Range | null;
};

/**
 * Whether `el` is a text field whose selection can be read and set.
 *
 * The tag name alone is not enough. `<input>` covers checkbox, radio, button, range, colour
 * and file too, and `setSelectionRange` throws `InvalidStateError` on every one of those --
 * verified in jsdom: a checkbox reports `selectionStart === null` and throws, while a text
 * input and a textarea report `0` and do not.
 *
 * That mattered because `resolveEditableTarget` tests this FIRST, so a right-click on a
 * checkbox produced an editable target with `selectionStart ?? 0` papering over the null, and
 * "Select All" -- the one item with no `disabled` flag -- then called `setSelectionRange` on it
 * and threw uncaught. Gating on `selectionStart` fixes both halves: a checkbox is no longer
 * treated as editable at all, which is also right, since there is no text in it to edit.
 */
const isTextInput = (
  el: HTMLElement,
): el is HTMLInputElement | HTMLTextAreaElement =>
  el.tagName === "TEXTAREA" ||
  (el.tagName === "INPUT" && (el as HTMLInputElement).selectionStart !== null);

/** Snapshot the current selection for a contenteditable element. */
const contentEditableSelection = (): { text: string; range: Range | null } => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { text: "", range: null };
  return { text: sel.toString(), range: sel.getRangeAt(0).cloneRange() };
};

/**
 * Return the owning contenteditable host for `target`. An explicit nested
 * `contenteditable="false"` is a boundary: it must not inherit the outer
 * editor's clipboard menu.
 */
const getContentEditableHost = (target: HTMLElement): HTMLElement | null => {
  for (
    let current: HTMLElement | null = target;
    current;
    current = current.parentElement
  ) {
    const value = current.getAttribute("contenteditable");
    if (value === "false") return null;
    if (value === "" || value === "true") return current;
  }
  return null;
};

/**
 * Resolve the editable root for a right-click target. Returns null when the
 * click is not on (or inside) an editable surface.
 */
const resolveEditableTarget = (target: HTMLElement): EditableTarget | null => {
  if (isTextInput(target)) {
    const start = target.selectionStart ?? 0;
    const end = target.selectionEnd ?? 0;
    return {
      el: target,
      text: target.value.slice(start, end),
      start,
      end,
      range: null,
    };
  }

  const host = getContentEditableHost(target);
  if (!host) return null;
  const selection = contentEditableSelection();
  return {
    el: host,
    text: selection.text,
    start: -1,
    end: -1,
    range: selection.range,
  };
};

/**
 * True when the right-click target is, or is inside, an editable surface
 * (input/textarea/contenteditable). Surfaces use this to yield those
 * right-clicks to the provider's clipboard menu (Cut/Copy/Paste/Select All)
 * instead of showing their own row/context menu.
 */
export const isEditableTarget = (target: EventTarget | null): boolean => {
  return (
    target instanceof HTMLElement && resolveEditableTarget(target) !== null
  );
};

/** Focus the editable and restore its selection so clipboard commands act on it. */
const focusEditable = (t: EditableTarget): void => {
  t.el.focus();
  if (isTextInput(t.el)) {
    if (t.start >= 0) t.el.setSelectionRange(t.start, t.end);
    return;
  }
  if (t.range) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(t.range);
  }
};

/**
 * Provider that owns the app-wide context-menu instance. Surfaces render their
 * own menus through `useContextMenu()`; this provider additionally handles
 * right-clicks on editable surfaces (inputs/textareas/contenteditable) by
 * showing a localized clipboard menu (Cut/Copy/Paste/Select All). Non-editable
 * right-clicks are left to the platform's native menu.
 */
export const ContextMenuProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const ctxMenu = useContextMenu();
  const intl = useIntl();

  // Platform detection for accelerator display. `navigator.platform` is
  // deprecated; prefer `userAgentData` where available (a newer, not-yet-typed
  // API) and fall back to the legacy property.
  const userAgentDataPlatform =
    typeof navigator !== "undefined"
      ? (
          navigator as Navigator & {
            userAgentData?: { platform: string };
          }
        ).userAgentData?.platform
      : undefined;
  const isMac =
    typeof userAgentDataPlatform === "string"
      ? /mac/i.test(userAgentDataPlatform)
      : typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  const modKey = isMac ? "\u2318" : "Ctrl";

  // Global right-click handler - suppress default on ALL elements
  useEffect(() => {
    const handleGlobalContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const editable = resolveEditableTarget(target);
      if (!editable) return;

      // Suppress the default webview menu only where we have a real menu to
      // show (clipboard actions). Elsewhere we keep the native menu — an
      // empty custom menu is worse than the platform default.
      e.preventDefault();

      const hasSelection = editable.text.length > 0;
      const copySelection = () => {
        // `writeText` can reject (permission denied in some webviews); swallow
        // it rather than surface an unhandled rejection.
        void navigator.clipboard
          .writeText(editable.text)
          .catch(() => undefined);
      };

      ctxMenu.handleContextMenu(e, [
        {
          label: intl.formatMessage({ defaultMessage: "Cut" }),
          icon: <Scissors size={16} strokeWidth={1.9} />,
          disabled: !hasSelection,
          onClick: () => {
            // Restore focus + selection to the editable so the native cut
            // operates on it, not on the (auto-focused) menu.
            focusEditable(editable);
            document.execCommand("cut"); // NOSONAR: no non-deprecated API for Cut
            copySelection();
          },
          accelerator: modKey + "+X",
        },
        {
          label: intl.formatMessage({ defaultMessage: "Copy" }),
          icon: <ClipboardCopy size={16} strokeWidth={1.9} />,
          disabled: !hasSelection,
          onClick: copySelection,
          accelerator: modKey + "+C",
        },
        { kind: "divider" },
        {
          label: intl.formatMessage({ defaultMessage: "Paste" }),
          icon: <ClipboardPaste size={16} strokeWidth={1.9} />,
          onClick: () => {
            // `readText` can reject (permission denied / no clipboard access);
            // swallow it rather than surface an unhandled rejection.
            void navigator.clipboard
              .readText()
              .then((text) => {
                focusEditable(editable);
                document.execCommand("insertText", false, text); // NOSONAR: no non-deprecated paste API
              })
              .catch(() => undefined);
          },
          accelerator: modKey + "+V",
        },
        { kind: "divider" },
        {
          label: intl.formatMessage({ defaultMessage: "Select All" }),
          icon: <SquareDashedMousePointer size={16} strokeWidth={1.9} />,
          onClick: () => {
            focusEditable(editable);
            if (isTextInput(editable.el)) {
              editable.el.select();
            } else {
              document.execCommand("selectAll"); // NOSONAR: no non-deprecated API for Select All
            }
          },
          accelerator: modKey + "+A",
        },
      ]);
    };

    document.addEventListener("contextmenu", handleGlobalContextMenu);
    return () => {
      document.removeEventListener("contextmenu", handleGlobalContextMenu);
    };
  }, [ctxMenu, intl]);

  return (
    <>
      {children}
      {ctxMenu.renderMenu()}
    </>
  );
};
