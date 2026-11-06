// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { ThemeProvider } from "@mui/material/styles";
import { theme } from "../../theme";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureUiHarness } from "../../../test/helpers/jsdom-ui-harness";
import { INITIAL_APP_STATE } from "../../state/app.state";
import { produceAppState, setAppState } from "../../store";

const mocks = vi.hoisted(() => ({
  devices: vi.fn(),
  statuses: vi.fn(),
  download: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  model: vi.fn().mockResolvedValue(undefined),
  error: vi.fn(),
  capabilities: null as null | { ramGb: number; cpuCores: number; gpus: [] },
}));
vi.mock("react-intl", async (importOriginal) => {
  const { reactIntlMockModule } =
    await import("../../../test/helpers/react-intl-mock");
  return reactIntlMockModule(importOriginal);
});
vi.mock("../../actions/settings-local-transcription.actions", () => ({
  refreshLocalTranscriptionDevices: mocks.devices,
  refreshLocalTranscriptionModelStatuses: mocks.statuses,
  downloadLocalTranscriptionModel: mocks.download,
  pauseLocalTranscriptionModelDownload: mocks.pause,
  resumeLocalTranscriptionModelDownload: mocks.resume,
  cancelLocalTranscriptionModelDownload: mocks.cancel,
  deleteLocalTranscriptionModel: mocks.remove,
}));
vi.mock("../../actions/app.actions", () => ({
  showErrorSnackbar: mocks.error,
}));
vi.mock("../../actions/user.actions", () => ({
  setPreferredTranscriptionApiKeyId: vi.fn().mockResolvedValue(undefined),
  setPreferredTranscriptionDevice: vi.fn().mockResolvedValue(undefined),
  setPreferredTranscriptionMode: vi.fn().mockResolvedValue(undefined),
  setPreferredTranscriptionModelSize: mocks.model,
}));
vi.mock("../../hooks/system-capabilities.hooks", () => ({
  useSystemCapabilities: () => ({ capabilities: mocks.capabilities }),
}));
vi.mock("../common/AnimateIn", () => ({
  AnimateSwitch: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../common/SegmentedControl", () => ({ SegmentedControl: () => null }));
vi.mock("./ApiKeyList", () => ({ ApiKeyList: () => null }));
import { AITranscriptionConfiguration } from "./AITranscriptionConfiguration";

ensureUiHarness();
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.capabilities = null;
  setAppState(structuredClone(INITIAL_APP_STATE), true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        ThemeProvider,
        { theme },
        createElement(AITranscriptionConfiguration),
      ),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});
const tinyRow = () => {
  const label = [...container.querySelectorAll<HTMLElement>("p")].find(
    (item) => item.textContent === "Whisper Tiny (77 MB)",
  );
  if (!label) throw new Error("Missing tiny model");
  const row = label.closest<HTMLElement>(".MuiBox-root");
  if (!row?.parentElement?.parentElement) throw new Error("Missing model row");
  return row.parentElement.parentElement;
};
const button = (row: HTMLElement, label: string) => {
  const found = [...row.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
};

it("refreshes local devices and model states and starts the selected download", async () => {
  expect(mocks.devices).toHaveBeenCalled();
  expect(mocks.statuses).toHaveBeenCalled();
  await act(async () => button(tinyRow(), "Download").click());
  expect(mocks.download).toHaveBeenCalledWith("tiny");
});

it("shows download progress and offers pause, resume, and cancel", async () => {
  const snapshot = {
    jobId: "job",
    model: "tiny" as const,
    status: "running" as const,
    bytesDownloaded: 10,
    totalBytes: 20,
    progress: 0.5,
    error: null,
  };
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.localModelManagement.modelDownloads.tiny =
        snapshot;
    }),
  );
  let row = tinyRow();
  expect(row.textContent).toContain("50%");
  await act(async () => button(row, "Pause").click());
  expect(mocks.pause).toHaveBeenCalledWith("tiny");
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.localModelManagement.modelDownloads.tiny =
        { ...snapshot, status: "paused" };
    }),
  );
  row = tinyRow();
  await act(async () => button(row, "Resume").click());
  expect(mocks.resume).toHaveBeenCalledWith("tiny");
  await act(async () => button(row, "Cancel").click());
  expect(mocks.cancel).toHaveBeenCalledWith("tiny");
});

it("does not replace a newly chosen model when an earlier deletion completes", async () => {
  const tiny = {
    model: "tiny" as const,
    downloaded: true,
    valid: true,
    fileBytes: 1,
    validationError: null,
  };
  const base = {
    model: "base" as const,
    downloaded: true,
    valid: true,
    fileBytes: 1,
    validationError: null,
  };
  const small = {
    model: "small" as const,
    downloaded: true,
    valid: true,
    fileBytes: 1,
    validationError: null,
  };
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.modelSize = "tiny";
      draft.settings.aiTranscription.localModelManagement.modelStatuses.tiny =
        tiny;
      draft.settings.aiTranscription.localModelManagement.modelStatuses.base =
        base;
      draft.settings.aiTranscription.localModelManagement.modelStatuses.small =
        small;
    }),
  );
  let finish!: (statuses: { base: typeof base; small: typeof small }) => void;
  mocks.remove.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => button(tinyRow(), "Delete").click());
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.modelSize = "small";
    }),
  );
  await act(async () => finish({ base, small }));
  expect(mocks.model).not.toHaveBeenCalled();
});

it("does not apply a deleted model's fallback to a later auth session", async () => {
  const status = {
    model: "tiny" as const,
    downloaded: true,
    valid: true,
    fileBytes: 1,
    validationError: null,
  };
  const fallback = { ...status, model: "base" as const };
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.modelSize = "tiny";
      draft.settings.aiTranscription.localModelManagement.modelStatuses.tiny =
        status;
    }),
  );
  let finish!: (statuses: { base: typeof fallback }) => void;
  mocks.remove.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => button(tinyRow(), "Delete").click());
  await act(async () =>
    produceAppState((draft) => {
      draft.authSessionNonce += 1;
    }),
  );
  await act(async () => finish({ base: fallback }));
  expect(mocks.model).not.toHaveBeenCalled();
});

it("chooses an available fallback when the deleted model is still selected", async () => {
  const status = {
    model: "tiny" as const,
    downloaded: true,
    valid: true,
    fileBytes: 1,
    validationError: null,
  };
  const fallback = { ...status, model: "base" as const };
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.modelSize = "tiny";
      draft.settings.aiTranscription.localModelManagement.modelStatuses.tiny =
        status;
    }),
  );
  mocks.remove.mockResolvedValueOnce({ base: fallback });
  await act(async () => button(tinyRow(), "Delete").click());
  expect(mocks.model).toHaveBeenCalledWith("base");
});

it("does not change model preferences if the user switched to API mode during deletion", async () => {
  const status = {
    model: "tiny" as const,
    downloaded: true,
    valid: true,
    fileBytes: 1,
    validationError: null,
  };
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.modelSize = "tiny";
      draft.settings.aiTranscription.localModelManagement.modelStatuses.tiny =
        status;
    }),
  );
  let finish!: (value: { base: typeof status }) => void;
  mocks.remove.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => button(tinyRow(), "Delete").click());
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.mode = "api";
    }),
  );
  await act(async () => finish({ base: status }));
  expect(mocks.model).not.toHaveBeenCalled();
});

it("refuses undownloaded models and accepts a validated model from the menu", async () => {
  const openMenu = async () => {
    const select = container.querySelector<HTMLElement>(
      '[aria-labelledby*="transcription-model-label"]',
    );
    expect(select).not.toBeNull();
    await act(async () =>
      select?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      ),
    );
  };
  const chooseBase = async () => {
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent?.includes("Whisper Base (148 MB)"));
    expect(option).toBeDefined();
    await act(async () => option?.click());
  };
  await openMenu();
  await chooseBase();
  expect(mocks.error).toHaveBeenCalledWith(
    "Download this model before selecting it.",
  );
  expect(mocks.model).not.toHaveBeenCalled();
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.localModelManagement.modelStatuses.base = {
        model: "base",
        downloaded: true,
        valid: true,
        fileBytes: 1,
        validationError: null,
      };
    }),
  );
  await openMenu();
  await chooseBase();
  expect(mocks.model).toHaveBeenCalledWith("base");
});

it("shows caution and discouraged icons for hardware-constrained models", async () => {
  mocks.capabilities = { ramGb: 2, cpuCores: 2, gpus: [] };
  await act(async () =>
    root.render(
      createElement(
        ThemeProvider,
        { theme },
        createElement(AITranscriptionConfiguration),
      ),
    ),
  );
  const select = container.querySelector<HTMLElement>(
    '[aria-labelledby*="transcription-model-label"]',
  );
  await act(async () =>
    select?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    ),
  );
  const small = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((item) => item.textContent?.includes("Whisper Small (488 MB)"));
  const large = [
    ...document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((item) => item.textContent?.includes("Whisper Large v3 (3.1 GB)"));
  expect(
    small?.querySelector('svg[data-testid="WarningAmberRoundedIcon"]'),
  ).not.toBeNull();
  expect(
    large?.querySelector('svg[data-testid="WarningAmberRoundedIcon"]'),
  ).not.toBeNull();
});

it("selects an available fallback only after model status loading completes", async () => {
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.modelSize = "tiny";
      draft.settings.aiTranscription.localModelManagement.modelStatuses.base = {
        model: "base",
        downloaded: true,
        valid: true,
        fileBytes: 1,
        validationError: null,
      };
    }),
  );
  expect(mocks.model).not.toHaveBeenCalled();
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.localModelManagement.modelStatusesLoaded = true;
    }),
  );
  expect(mocks.model).toHaveBeenCalledWith("base");
});

it("observes a rejected fallback preference save", async () => {
  mocks.model.mockRejectedValueOnce(new Error("save failed"));
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.modelSize = "tiny";
      draft.settings.aiTranscription.localModelManagement.modelStatuses.base = {
        model: "base",
        downloaded: true,
        valid: true,
        fileBytes: 1,
        validationError: null,
      };
      draft.settings.aiTranscription.localModelManagement.modelStatusesLoaded = true;
    }),
  );
  expect(mocks.model).toHaveBeenCalledWith("base");
});

it("shows hardware-fit guidance for the currently selected model", async () => {
  mocks.capabilities = { ramGb: 2, cpuCores: 2, gpus: [] };
  await act(async () => {
    produceAppState((draft) => {
      draft.settings.aiTranscription.modelSize = "small";
    });
    root.render(
      createElement(
        ThemeProvider,
        { theme },
        createElement(AITranscriptionConfiguration),
      ),
    );
  });
  expect(container.textContent).toContain(
    "This model may be slow on this device.",
  );
  await act(async () =>
    produceAppState((draft) => {
      draft.settings.aiTranscription.modelSize = "large";
    }),
  );
  expect(container.textContent).toContain(
    "This model is likely too heavy for this device.",
  );
});
