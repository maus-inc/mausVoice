// @vitest-environment jsdom
import { ThemeProvider } from "@mui/material";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it } from "vitest";
import { showSnackbar } from "../../actions/app.actions";
import { getAppState, produceAppState, setAppState } from "../../store";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { THEME_PROVIDER_CONFIG, theme } from "../../theme";
import { SNACKBAR_QUEUE_LIMIT, setSnackbar } from "../../utils/app.utils";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { resetSnackbarEmitForTests } from "./snackbar-emit";
import { SnackbarEmitter } from "./SnackbarEmitter";

ensureUiHarness();

const toasts = () =>
  Array.from(document.body.querySelectorAll("[data-sonner-toast]")).map(
    (node) => node.textContent?.trim() ?? "",
  );

const mount = async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ThemeProvider theme={theme} {...THEME_PROVIDER_CONFIG}>
        <SnackbarEmitter />
      </ThemeProvider>,
    );
  });
  return { root, container };
};

beforeEach(() => {
  toast.dismiss();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  resetSnackbarEmitForTests();
});

// Sonner's toast list is global: unmounting the toaster does not clear it, so a
// toast left by one test appears in the next one's DOM and makes the counts lie.
afterEach(() => {
  toast.dismiss();
});

it("shows every snackbar raised in one tick, not only the last", async () => {
  // React batches, so both of these land in a single store update and a single
  // effect run. When the state held one message slot, the first was overwritten
  // before the emitter ever looked: not delayed, dropped.
  const { root, container } = await mount();
  try {
    await act(async () => {
      showSnackbar("first message");
      showSnackbar("second message");
    });
    const shown = toasts();
    expect(shown).toContain("first message");
    expect(shown).toContain("second message");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("keeps the counter order when three are raised together", async () => {
  const { root, container } = await mount();
  try {
    await act(async () => {
      produceAppState((draft) => {
        setSnackbar(draft, "one", { duration: 1000 });
        setSnackbar(draft, "two", { duration: 1000 });
        setSnackbar(draft, "three", { duration: 1000 });
      });
    });
    // Sonner stacks newest first, so the order is the reverse of the queue --
    // which is how the reader sees it, and what makes "three" the top toast.
    expect(toasts()).toEqual(["three", "two", "one"]);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("keeps the newest requests when the queue overflows", async () => {
  produceAppState((draft) => {
    for (let index = 0; index < SNACKBAR_QUEUE_LIMIT + 5; index += 1) {
      setSnackbar(draft, `message ${index}`);
    }
  });
  const requests = getAppState().snackbarRequests;
  expect(requests).toHaveLength(SNACKBAR_QUEUE_LIMIT);
  expect(requests[0].message).toBe("message 5");
  expect(requests.at(-1)?.message).toBe(`message ${SNACKBAR_QUEUE_LIMIT + 4}`);
  // The scalar mirror still describes the newest request, not the trim.
  expect(getAppState().snackbarMessage).toBe(
    `message ${SNACKBAR_QUEUE_LIMIT + 4}`,
  );
});
