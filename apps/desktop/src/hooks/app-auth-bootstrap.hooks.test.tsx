// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

type Setter = (ready: boolean) => void;
const mocks = vi.hoisted(() => ({
  ready: true,
  auth: null as null | {
    setAuthReady: Setter;
    setInitReady: Setter;
    setStreamReady: Setter;
  },
  resume: vi.fn(),
  logger: { info: vi.fn() },
}));
vi.mock("./elevation.hooks", () => ({
  useElevationStartupReady: () => mocks.ready,
}));
vi.mock("./auth-state-sync.hooks", () => ({
  useAuthStateSync: (options: typeof mocks.auth) => {
    mocks.auth = options;
  },
}));
vi.mock("./authenticated-profile-stream.hooks", () => ({
  useAuthenticatedProfileStream: vi.fn(),
}));
vi.mock("./post-elevation-user-init.hooks", () => ({
  usePostElevationUserInit: vi.fn(),
}));
vi.mock("./remote-receiver-init.hooks", () => ({
  useRemoteReceiverInit: vi.fn(),
}));
vi.mock("../utils/pending-transcription-delete", () => ({
  resumePendingTranscriptionDeletes: mocks.resume,
}));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
import { useAppAuthBootstrap } from "./app-auth-bootstrap.hooks";

const Probe = ({ main }: { main: boolean }) => {
  useAppAuthBootstrap(main);
  return null;
};
describe("account initialization orchestration", () => {
  let root: Root;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ready = true;
    mocks.auth = null;
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    setAppState(structuredClone(INITIAL_APP_STATE), true);
    vi.unstubAllGlobals();
  });
  it("initializes only after both profile and user initialization complete", async () => {
    await act(async () => root.render(createElement(Probe, { main: true })));
    await act(async () => {
      mocks.auth!.setAuthReady(true);
      mocks.auth!.setStreamReady(true);
    });
    expect(getAppState().initialized).toBe(false);
    await act(async () => mocks.auth!.setInitReady(true));
    expect(getAppState().initialized).toBe(true);
    expect(mocks.resume).toHaveBeenCalledOnce();
  });
  it("does not initialize before elevation or resume deletes in a secondary window", async () => {
    mocks.ready = false;
    await act(async () => root.render(createElement(Probe, { main: false })));
    await act(async () => {
      mocks.auth!.setAuthReady(true);
      mocks.auth!.setStreamReady(true);
      mocks.auth!.setInitReady(true);
    });
    expect(getAppState().initialized).toBe(false);
    mocks.ready = true;
    await act(async () => root.render(createElement(Probe, { main: false })));
    expect(getAppState().initialized).toBe(true);
    expect(mocks.resume).not.toHaveBeenCalled();
  });
});
