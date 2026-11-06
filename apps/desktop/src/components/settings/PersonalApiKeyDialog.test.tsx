// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ show: vi.fn(), openUrl: vi.fn() }));
vi.mock("../../actions/app.actions", () => ({ showSnackbar: mocks.show }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("react-intl", () => ({
  FormattedMessage: ({
    defaultMessage,
    values,
  }: {
    defaultMessage: string;
    values?: { suffix: string };
  }) => defaultMessage.replace("{suffix}", values?.suffix ?? ""),
}));
import {
  PersonalApiKeyDialog,
  usePersonalApiKeyDialog,
} from "./PersonalApiKeyDialog";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let state: ReturnType<typeof usePersonalApiKeyDialog>;
const saveKey = vi.fn<(value: string) => Promise<unknown>>();
const Harness = () => {
  state = usePersonalApiKeyDialog(saveKey, "Groq");
  return (
    <PersonalApiKeyDialog
      state={state}
      suffix="1234"
      title="Groq API key"
      description="Encrypted"
      placeholder="gsk_..."
      keyUrl="https://console.groq.com/keys"
      linkLabel="Open keys"
    />
  );
};
const button = (label: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label,
  );
beforeEach(async () => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("personal API key dialog", () => {
  it("shows the existing suffix, password field, and provider link", async () => {
    await act(async () => state.show());
    expect(document.body.textContent).toContain("Current key ends with 1234.");
    const input = document.querySelector("input");
    expect(input?.type).toBe("password");
    expect(input?.placeholder).toBe("gsk_...");
    expect(input?.getAttribute("data-mausvoice-ignore")).toBe("true");
    await act(async () => button("Open keys")?.click());
    expect(mocks.openUrl).toHaveBeenCalledExactlyOnceWith(
      "https://console.groq.com/keys",
    );
  });
  it("trims keys and blocks duplicate saves and closing while pending", async () => {
    let release: (value: unknown) => void = () => {};
    saveKey.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await act(async () => state.show());
    act(() => state.setInput("  secret  "));
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = state.save();
      second = state.save();
      state.close();
    });
    expect(saveKey).toHaveBeenCalledExactlyOnceWith("secret");
    expect(state.open).toBe(true);
    expect(state.saving).toBe(true);
    await act(async () => {
      release({});
      await Promise.all([first, second]);
    });
    expect(state.open).toBe(false);
    expect(state.input).toBe("");
    expect(mocks.show).toHaveBeenCalledExactlyOnceWith("Groq API key saved", {
      mode: "success",
    });
  });
  it("keeps a failed draft for retry and clears errors when reopened", async () => {
    saveKey.mockRejectedValueOnce(new Error("network"));
    await act(async () => state.show());
    act(() => state.setInput("secret"));
    await act(async () => {
      await state.save();
    });
    expect(state.error).toBe("network");
    expect(state.input).toBe("secret");
    expect(state.open).toBe(true);
    act(() => state.close());
    act(() => state.show());
    expect(state.error).toBeNull();
    expect(state.input).toBe("");
  });
  it("does not save an empty key and reports non-Error failures", async () => {
    await act(async () => state.show());
    act(() => state.setInput("  "));
    await act(async () => {
      await state.save();
    });
    expect(saveKey).not.toHaveBeenCalled();
    saveKey.mockRejectedValueOnce("network");
    act(() => state.setInput("secret"));
    await act(async () => {
      await state.save();
    });
    expect(state.error).toBe("Failed to save Groq API key.");
  });
});
