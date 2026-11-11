// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import de from "../../i18n/locales/de.json";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import {
  MicrophoneSelector,
  type MicrophoneSelectorProps,
} from "./MicrophoneSelector";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@maus-inc/desktop-native-apis", () => ({
  commands: { listMicrophones: mocks.list },
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
ensureUiHarness();
type Devices = { label: string; isDefault: boolean; caution: boolean }[];
const device = (label: string): Devices => [
  { label, isDefault: false, caution: false },
];
const pending = () => {
  const control = {
    resolve: vi.fn<(value: Devices) => void>(),
    reject: vi.fn<(reason: unknown) => void>(),
  };
  const promise = new Promise<Devices>((resolve, reject) => {
    control.resolve.mockImplementation(resolve);
    control.reject.mockImplementation(reject);
  });
  return { ...control, promise };
};
let root: Root | undefined;
let container: HTMLDivElement;
let media: EventTarget;
let originalMedia: PropertyDescriptor | undefined;
let errors: ReturnType<typeof vi.spyOn>;
const render = async (
  props: Partial<MicrophoneSelectorProps> = {},
  locale = "en",
  messages = {},
) => {
  await act(async () =>
    root?.render(
      <IntlProvider
        locale={locale}
        messages={messages}
        onError={() => undefined}
      >
        <MicrophoneSelector value="new mic" onChange={vi.fn()} {...props} />
      </IntlProvider>,
    ),
  );
};
beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue(device("new mic"));
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  media = new EventTarget();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: media,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  if (originalMedia)
    Object.defineProperty(navigator, "mediaDevices", originalMedia);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  vi.restoreAllMocks();
});

describe("microphone request ownership", () => {
  it("ignores an older success after a newer device-change load finishes", async () => {
    const first = pending();
    const second = pending();
    mocks.list
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await render();
    await act(async () => media.dispatchEvent(new Event("devicechange")));
    expect(mocks.list).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(device("new mic")));
    expect(container.textContent).not.toContain("Currently unavailable");
    await act(async () => first.resolve(device("old mic")));
    expect(container.textContent).not.toContain("Currently unavailable");
  });

  it("keeps the latest request loading when an obsolete request fails", async () => {
    const first = pending();
    const second = pending();
    mocks.list
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await render();
    await act(async () => media.dispatchEvent(new Event("devicechange")));
    await act(async () =>
      first.reject(new Error("private old device details")),
    );
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    await act(async () => second.resolve(device("new mic")));
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("does not overwrite supplied devices with a pending native result", async () => {
    const first = pending();
    mocks.list.mockReturnValueOnce(first.promise);
    await render();
    await render({
      microphones: [{ value: "new mic", label: "Provided microphone" }],
    });
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => first.resolve(device("old mic")));
    expect(container.textContent).toContain("Provided microphone");
    expect(container.textContent).not.toContain("Currently unavailable");
    await act(async () => media.dispatchEvent(new Event("devicechange")));
    expect(mocks.list).toHaveBeenCalledOnce();
    expect(container.querySelector("button")?.disabled).toBe(true);
  });

  it("drops late failures after unmount without logging device details", async () => {
    const first = pending();
    mocks.list.mockReturnValueOnce(first.promise);
    await render();
    act(() => root?.unmount());
    root = undefined;
    await act(async () =>
      first.reject(new Error("private unmounted device details")),
    );
    expect(errors).not.toHaveBeenCalled();
    media.dispatchEvent(new Event("devicechange"));
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("localizes failures at render time without reloading or echoing native errors", async () => {
    mocks.list.mockRejectedValueOnce(
      new Error("secret device and user directory"),
    );
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Unable to fetch microphones. Please try again.",
    );
    expect(JSON.stringify(errors.mock.calls)).not.toContain("secret device");
    await render({}, "de", de);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Mikrofone konnten nicht geladen werden",
    );
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it("localizes missing-device labels", async () => {
    await render({ microphones: [] }, "de", de);
    expect(container.textContent).toContain("new mic (nicht verfügbar)");
  });

  it("disables manual refresh along with the selector", async () => {
    await render({ disabled: true });
    expect(container.querySelector("button")?.disabled).toBe(true);
  });
});
