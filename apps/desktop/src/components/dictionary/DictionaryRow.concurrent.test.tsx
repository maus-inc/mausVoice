// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Term } from "@maus-inc/types";
import { beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import {
  getAppState,
  produceAppState,
  setAppState,
  useAppStore,
} from "../../store";
const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  remove: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../repos", () => ({
  getTermRepo: () => ({ updateTerm: mocks.update, deleteTerm: mocks.remove }),
}));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.error,
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import { IntlProvider } from "react-intl";
import en from "../../i18n/locales/en.json";
import { DictionaryRow } from "./DictionaryRow";
ensureUiHarness();
const original = {
  id: "a",
  sourceValue: "before",
  destinationValue: "after",
  isReplacement: true,
  isGlobal: false,
} as Term;
const deferred = () => {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const List = () => {
  const ids = useAppStore((s) => s.dictionary.termIds);
  return (
    <main>
      <button data-dictionary-add>Add</button>
      {ids.map((id) => (
        <DictionaryRow key={id} id={id} />
      ))}
    </main>
  );
};
beforeEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  mocks.update.mockReset();
  mocks.remove.mockReset();
  mocks.error.mockReset();
  produceAppState((s) => {
    s.termById.a = original;
    s.dictionary.termIds = ["a"];
  });
});
const mount = async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={en}>
        <List />
      </IntlProvider>,
    ),
  );
  return {
    host,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
};
const edit = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto =
    input instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
it("does not let an older failed update discard a newer edit", async () => {
  const first = deferred();
  mocks.update.mockReturnValueOnce(first.promise).mockResolvedValue(original);
  const { host, close } = await mount();
  try {
    const source = host.querySelector<HTMLInputElement>(
      'input[aria-label="Original"]',
    )!;
    const replacement = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Replacement"]',
    )!;
    edit(source, "first");
    await act(async () => source.blur());
    edit(replacement, "second");
    await act(async () => replacement.blur());
    await act(async () => {
      first.reject(new Error("failed"));
      await first.promise.catch(() => {});
    });
    expect(getAppState().termById.a.sourceValue).toBe("first");
    expect(getAppState().termById.a.destinationValue).toBe("second");
  } finally {
    close();
  }
});

it("preserves an uncommitted draft in the other field when a save fails", async () => {
  const first = deferred();
  mocks.update.mockReturnValue(first.promise);
  const { host, close } = await mount();
  try {
    const source = host.querySelector<HTMLInputElement>(
      'input[aria-label="Original"]',
    )!;
    const replacement = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Replacement"]',
    )!;
    edit(source, "first");
    await act(async () => source.blur());
    edit(replacement, "unfinished");
    await act(async () => {
      first.reject(new Error("failed"));
      await first.promise.catch(() => {});
    });
    expect(source.value).toBe("before");
    expect(replacement.value).toBe("unfinished");
    expect(getAppState().termById.a.sourceValue).toBe("before");
  } finally {
    close();
  }
});

it("rolls back to the last persisted term if two queued saves fail", async () => {
  const first = deferred(),
    second = deferred();
  mocks.update
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const { host, close } = await mount();
  try {
    const source = host.querySelector<HTMLInputElement>(
      'input[aria-label="Original"]',
    )!;
    const replacement = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Replacement"]',
    )!;
    edit(source, "first");
    await act(async () => source.blur());
    edit(replacement, "second");
    await act(async () => replacement.blur());
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.reject(new Error("first"));
      await first.promise.catch(() => {});
    });
    expect(mocks.update).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.reject(new Error("second"));
      await second.promise.catch(() => {});
    });
    expect(getAppState().termById.a.sourceValue).toBe("before");
    expect(getAppState().termById.a.destinationValue).toBe("after");
  } finally {
    close();
  }
});

it("waits for a pending save before deleting, and restores the persisted version if both fail", async () => {
  const first = deferred(),
    removal = deferred();
  mocks.update.mockReturnValue(first.promise);
  mocks.remove.mockReturnValue(removal.promise);
  const { host, close } = await mount();
  try {
    const source = host.querySelector<HTMLInputElement>(
      'input[aria-label="Original"]',
    )!;
    edit(source, "first");
    await act(async () => source.blur());
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>("[data-dictionary-delete]")!
        .click(),
    );
    expect(mocks.remove).not.toHaveBeenCalled();
    await act(async () => {
      first.reject(new Error("save failed"));
      await first.promise.catch(() => {});
    });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    await act(async () => {
      removal.reject(new Error("delete failed"));
      await removal.promise.catch(() => {});
    });
    expect(getAppState().dictionary.termIds).toEqual(["a"]);
    expect(getAppState().termById.a.sourceValue).toBe("before");
  } finally {
    close();
  }
});

it("performs a successful pending save before deletion so a late save cannot revive the row", async () => {
  const first = deferred();
  mocks.update.mockReturnValue(first.promise);
  mocks.remove.mockResolvedValue(undefined);
  const { host, close } = await mount();
  try {
    const source = host.querySelector<HTMLInputElement>(
      'input[aria-label="Original"]',
    )!;
    edit(source, "first");
    await act(async () => source.blur());
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>("[data-dictionary-delete]")!
        .click(),
    );
    expect(mocks.remove).not.toHaveBeenCalled();
    await act(async () => {
      first.resolve();
      await first.promise;
    });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(getAppState().termById.a).toBeUndefined();
  } finally {
    close();
  }
});

it("restores the successful pending edit if the following delete fails", async () => {
  const first = deferred(),
    removal = deferred();
  mocks.update.mockReturnValue(first.promise);
  mocks.remove.mockReturnValue(removal.promise);
  const { host, close } = await mount();
  try {
    const source = host.querySelector<HTMLInputElement>(
      'input[aria-label="Original"]',
    )!;
    edit(source, "saved");
    await act(async () => source.blur());
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>("[data-dictionary-delete]")!
        .click(),
    );
    await act(async () => {
      first.resolve();
      await first.promise;
    });
    await act(async () => {
      removal.reject(new Error("delete failed"));
      await removal.promise.catch(() => {});
    });
    expect(getAppState().termById.a.sourceValue).toBe("saved");
    expect(
      host.querySelector<HTMLInputElement>('input[aria-label="Original"]')!
        .value,
    ).toBe("saved");
  } finally {
    close();
  }
});
