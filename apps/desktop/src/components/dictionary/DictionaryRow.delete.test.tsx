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
const mocks = vi.hoisted(() => ({ deleteTerm: vi.fn(), showError: vi.fn() }));
vi.mock("../../repos", () => ({
  getTermRepo: () => ({ deleteTerm: mocks.deleteTerm }),
}));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.showError,
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlWithIdsModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlWithIdsModule(importOriginal);
});
import { DictionaryRow } from "./DictionaryRow";
import { IntlProvider } from "react-intl";
import en from "../../i18n/locales/en.json";
ensureUiHarness();
const term = (id: string): Term =>
  ({
    id,
    sourceValue: id,
    destinationValue: "",
    isReplacement: false,
    isGlobal: false,
  }) as Term;
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
const deferred = () => {
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((_resolve, no) => {
    reject = no;
  });
  return { promise, reject };
};
beforeEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  mocks.deleteTerm.mockReset();
  mocks.showError.mockReset();
  produceAppState((s) => {
    for (const id of ["a", "b", "c"]) s.termById[id] = term(id);
    s.dictionary.termIds = ["a", "b", "c"];
  });
});

it("keeps concurrent deletions and additions when an older delete fails", async () => {
  const waiting = deferred();
  mocks.deleteTerm.mockImplementation((id: string) =>
    id === "a" ? waiting.promise : Promise.resolve(),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={en}>
          <List />
        </IntlProvider>,
      ),
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Delete dictionary item a"]',
        )!
        .click(),
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Delete dictionary item b"]',
        )!
        .click(),
    );
    act(() =>
      produceAppState((s) => {
        s.termById.d = term("d");
        s.dictionary.termIds.unshift("d");
      }),
    );
    await act(async () => {
      waiting.reject(new Error("failed"));
      await waiting.promise.catch(() => {});
    });
    expect(getAppState().dictionary.termIds).toEqual(["d", "a", "c"]);
    expect(getAppState().termById.b).toBeUndefined();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("does not replace a newer copy of the same term when deletion fails", async () => {
  const waiting = deferred();
  mocks.deleteTerm.mockReturnValue(waiting.promise);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={en}>
          <List />
        </IntlProvider>,
      ),
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Delete dictionary item a"]',
        )!
        .click(),
    );
    act(() =>
      produceAppState((s) => {
        s.termById.a = { ...term("a"), sourceValue: "newer" };
        s.dictionary.termIds.unshift("a");
      }),
    );
    await act(async () => {
      waiting.reject(new Error("failed"));
      await waiting.promise.catch(() => {});
    });
    expect(getAppState().termById.a.sourceValue).toBe("newer");
    expect(
      getAppState().dictionary.termIds.filter((id) => id === "a"),
    ).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("does not delete the next row on the second click of a double-click", async () => {
  mocks.deleteTerm.mockResolvedValue(undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={en}>
          <List />
        </IntlProvider>,
      ),
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Delete dictionary item a"]',
        )!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })),
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Delete dictionary item b"]',
        )!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 })),
    );
    expect(getAppState().dictionary.termIds).toEqual(["b", "c"]);
    expect(mocks.deleteTerm).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
