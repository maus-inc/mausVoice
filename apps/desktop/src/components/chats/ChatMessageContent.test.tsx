// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material/styles";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { theme } from "../../theme";
import {
  bubbleSx,
  chatBubbleMaxWidth,
  ChatMessageContent,
  MessageEditForm,
} from "./ChatMessageContent";

const openExternalUrlMock = vi.hoisted(() => vi.fn());

vi.mock("../../utils/open-url.utils", () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}));

vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatMessageContent bubble spacing, wrapping, and markdown containment", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    openExternalUrlMock.mockReset();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  const mountContent = async (
    node: Parameters<ReturnType<typeof createRoot>["render"]>[0],
  ) => {
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <StrictMode>
          <ThemeProvider theme={theme}>{node}</ThemeProvider>
        </StrictMode>,
      );
    });
  };

  it("defines shrink-wrap layout, responsive width bounds, comfortable padding, and textWrap overrides in bubbleSx", () => {
    const userSx = bubbleSx(true, false);
    const assistantSx = bubbleSx(false, false);
    const editingUserSx = bubbleSx(true, true);

    expect(userSx.minWidth).toBe(0);
    expect(userSx.width).toBe("fit-content");
    expect(userSx.maxWidth).toEqual(chatBubbleMaxWidth);
    expect(userSx.px).toBe(2);
    expect(userSx.py).toBe(1.5);
    expect(userSx.borderRadius).toBe(1);
    expect(userSx.overflowWrap).toBe("anywhere");
    expect(userSx.wordBreak).toBe("normal");
    expect(userSx.bgcolor).toBe("primary.main");
    expect(userSx.color).toBe("primary.contrastText");
    expect(userSx["& p, & li"]).toEqual({ textWrap: "wrap" });
    expect(userSx["& a"]).toMatchObject({
      color: "inherit",
      textDecoration: "underline",
    });

    expect(assistantSx.bgcolor).toBe("action.hover");
    expect(assistantSx.color).toBe("text.primary");

    // Inline editing switches user bubbles onto a neutral surface so the input
    // and Cancel/Resend buttons retain theme contrast in light and dark modes.
    expect(editingUserSx.width).toBe("100%");
    expect(editingUserSx.bgcolor).toBe("action.hover");
    expect(editingUserSx.color).toBe("text.primary");
    expect(editingUserSx.border).toBe(1);
    expect(editingUserSx["& button"]).toEqual({
      overflowWrap: "normal",
      wordBreak: "normal",
    });
  });

  it("applies computed wrap, overflow-wrap, and zero-margin paragraph styles inside rendered bubbles", async () => {
    await mountContent(
      <ChatMessageContent
        parts={[
          {
            kind: "text",
            text: "First paragraph with https://example.com/very/long/path.\n\nSecond paragraph.",
          },
        ]}
        permissions={[]}
        editor={null}
        isStreaming={false}
        isMe={true}
        canRetry={false}
        conversationId="conv-1"
      />,
    );

    const bubble = container.querySelector<HTMLElement>("[data-chat-bubble]");
    expect(bubble).not.toBeNull();
    const bubbleStyle = getComputedStyle(bubble as HTMLElement);
    expect(bubbleStyle.minWidth).toBe("0px");
    expect(bubbleStyle.overflowWrap).toBe("anywhere");
    expect(bubbleStyle.paddingTop).toBe("calc(1.5 * var(--app-spacing))");
    expect(bubbleStyle.paddingBottom).toBe("calc(1.5 * var(--app-spacing))");
    expect(bubbleStyle.paddingLeft).toBe("calc(2 * var(--app-spacing))");
    expect(bubbleStyle.paddingRight).toBe("calc(2 * var(--app-spacing))");

    const paragraphs = bubble?.querySelectorAll("p") ?? [];
    expect(paragraphs.length).toBe(2);
    expect(getComputedStyle(paragraphs[0]).marginTop).toBe("0px");
    expect(getComputedStyle(paragraphs[0]).textWrap).toBe("wrap");
    expect(getComputedStyle(paragraphs[1]).marginTop).toBe(
      "var(--app-spacing)",
    );
    expect(getComputedStyle(paragraphs[1]).marginBottom).toBe("0px");
  });

  it("wraps GFM tables in a horizontal scroll container and preserves preformatted code blocks", async () => {
    const markdown = [
      "### Release checks",
      "",
      "| Check | Artifact |",
      "| --- | --- |",
      "| Bundle | `mausVoice_0.1.6_aarch64_darwin_signed.dmg` |",
      "",
      "```bash",
      "pnpm --filter desktop run build",
      "```",
    ].join("\n");

    await mountContent(
      <ChatMessageContent
        parts={[{ kind: "text", text: markdown }]}
        permissions={[]}
        editor={null}
        isStreaming={false}
        isMe={false}
        canRetry={false}
        conversationId="conv-1"
      />,
    );

    const tableWrapper = container.querySelector<HTMLElement>(
      "[data-chat-table-scroll]",
    );
    expect(tableWrapper).not.toBeNull();
    expect(tableWrapper?.querySelector("table")).not.toBeNull();
    expect(getComputedStyle(tableWrapper as HTMLElement).overflowX).toBe(
      "auto",
    );
    expect(getComputedStyle(tableWrapper as HTMLElement).maxWidth).toBe("100%");

    const pre = container.querySelector<HTMLElement>("pre");
    const preCode = container.querySelector<HTMLElement>("pre code");
    expect(pre).not.toBeNull();
    expect(preCode).not.toBeNull();
    expect(getComputedStyle(pre as HTMLElement).overflowX).toBe("auto");
    expect(getComputedStyle(preCode as HTMLElement).whiteSpace).toBe("pre");
  });

  it("opens valid http/https markdown links externally and neutralizes non-web schemes", async () => {
    await mountContent(
      <ChatMessageContent
        parts={[
          {
            kind: "text",
            text: "Visit [Docs](https://docs.example.com/guide), skip [App](file:///etc/hosts), and skip [Auth](https://user:pass@example.com).",
          },
        ]}
        permissions={[]}
        editor={null}
        isStreaming={false}
        isMe={false}
        canRetry={false}
        conversationId="conv-1"
      />,
    );

    const anchors = container.querySelectorAll("a");
    expect(anchors.length).toBe(1);
    expect(anchors[0].getAttribute("href")).toBe(
      "https://docs.example.com/guide",
    );
    expect(container.textContent).toContain("App");
    expect(container.textContent).toContain("Auth");

    await act(async () => {
      anchors[0].dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://docs.example.com/guide",
      "a link in the chat",
    );
  });

  it("renders multi-part text messages and inline edit mode without button character breaking", async () => {
    await mountContent(
      <ChatMessageContent
        parts={[
          { kind: "text", text: "Part one" },
          { kind: "text", text: "Part two" },
        ]}
        permissions={[]}
        editor={null}
        isStreaming={false}
        isMe={false}
        canRetry={false}
        conversationId="conv-1"
      />,
    );
    expect(container.textContent).toContain("Part one");
    expect(container.textContent).toContain("Part two");

    act(() => {
      root?.unmount();
    });

    await mountContent(
      <ChatMessageContent
        parts={[{ kind: "text", text: "Original prompt" }]}
        permissions={[]}
        editor={
          <MessageEditForm
            draft="Updated prompt"
            confirmDrop={false}
            onChange={() => {}}
            onCancel={() => {}}
            onSave={() => {}}
          />
        }
        isStreaming={false}
        isMe={true}
        canRetry={false}
        conversationId="conv-1"
      />,
    );

    const bubble = container.querySelector<HTMLElement>("[data-chat-bubble]");
    expect(bubble).not.toBeNull();
    expect(getComputedStyle(bubble as HTMLElement).width).toBe("100%");
    const cancelButton = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.includes("Cancel"),
    );
    expect(cancelButton).toBeTruthy();
    expect(getComputedStyle(cancelButton as HTMLElement).overflowWrap).toBe(
      "normal",
    );
  });
});
