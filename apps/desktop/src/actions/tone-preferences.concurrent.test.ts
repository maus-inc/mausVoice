import { beforeEach, expect, it, vi } from "vitest";
import { seedManualStyles } from "../../test/helpers/tone-test.utils";
import { getAppState, produceAppState } from "../store";

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  delete: vi.fn(),
  logger: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
  },
}));
vi.mock("../repos", () => ({
  getToneRepo: () => ({ deleteTone: mocks.delete }),
  getUserPreferencesRepo: () => ({
    setUserPreferences: mocks.set,
    getUserPreferences: vi.fn().mockResolvedValue(null),
  }),
}));
vi.mock("../utils/log.utils", () => ({ getLogger: () => mocks.logger }));
vi.mock("./toast.actions", () => ({ showToast: vi.fn() }));
import { createDefaultPreferences } from "./user-actions-core";
import { setPreferredMicrophone } from "./user-preferences.actions";
import { deleteTone, setActiveTone } from "./tone.actions";

beforeEach(() => {
  seedManualStyles("default");
  produceAppState((draft) => {
    draft.userPrefs = {
      ...createDefaultPreferences(),
      activeToneId: "email",
      preferredMicrophone: null,
    };
  });
  mocks.set.mockReset().mockImplementation(async (value: unknown) => value);
  mocks.delete.mockReset().mockResolvedValue(undefined);
});

const blockFirstWrite = async () => {
  let resolve!: () => void;
  mocks.set.mockImplementationOnce(
    (value: unknown) =>
      new Promise((done) => {
        resolve = () => done(value);
      }),
  );
  const microphone = setPreferredMicrophone("USB mic");
  await vi.waitFor(() => expect(mocks.set).toHaveBeenCalledTimes(1));
  return { microphone, resolve: () => resolve() };
};

it("preserves a microphone update when setting the default style concurrently", async () => {
  const { microphone, resolve } = await blockFirstWrite();
  const style = setActiveTone("chat");
  await Promise.resolve();
  const concurrentWrites = mocks.set.mock.calls.length;
  resolve();
  await Promise.all([microphone, style]);
  expect(concurrentWrites).toBe(1);
  expect(getAppState().userPrefs).toMatchObject({
    preferredMicrophone: "USB mic",
    activeToneId: "chat",
  });
});

it("clears a deleted default without undoing an in-flight preference save", async () => {
  const { microphone, resolve } = await blockFirstWrite();
  const deletion = deleteTone("email");
  await vi.waitFor(() => expect(mocks.delete).toHaveBeenCalledOnce());
  const concurrentWrites = mocks.set.mock.calls.length;
  resolve();
  await Promise.all([microphone, deletion]);
  expect(concurrentWrites).toBe(1);
  expect(getAppState().userPrefs).toMatchObject({
    preferredMicrophone: "USB mic",
    activeToneId: null,
  });
});

it("does not select a style deleted while its selection is queued", async () => {
  const { microphone, resolve } = await blockFirstWrite();
  const selection = setActiveTone("chat");
  const deletion = deleteTone("chat");
  await vi.waitFor(() => expect(getAppState().toneById.chat).toBeUndefined());
  resolve();
  await Promise.all([microphone, selection, deletion]);
  expect(getAppState().userPrefs).toMatchObject({
    preferredMicrophone: "USB mic",
    activeToneId: "email",
  });
  expect(mocks.set).toHaveBeenCalledTimes(1);
});

it("preserves a newer default when deleting the previous one", async () => {
  const { microphone, resolve } = await blockFirstWrite();
  const selection = setActiveTone("chat");
  const deletion = deleteTone("email");
  await vi.waitFor(() => expect(getAppState().toneById.email).toBeUndefined());
  resolve();
  await Promise.all([microphone, selection, deletion]);
  expect(getAppState().userPrefs).toMatchObject({
    preferredMicrophone: "USB mic",
    activeToneId: "chat",
  });
  expect(mocks.set).toHaveBeenCalledTimes(2);
});

it("continues the queue after a failed default-style save", async () => {
  mocks.set.mockRejectedValueOnce(new Error("disk unavailable"));
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const selection = setActiveTone("chat");
    const microphone = setPreferredMicrophone("USB mic");
    await expect(selection).rejects.toThrow("disk unavailable");
    await microphone;
    expect(getAppState().userPrefs).toMatchObject({
      activeToneId: "email",
      preferredMicrophone: "USB mic",
    });
  } finally {
    consoleError.mockRestore();
  }
});
