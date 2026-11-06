import type { UserPreferences } from "@maus-inc/types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const mocks = vi.hoisted(() => ({
  repo: {
    getUserPreferences: vi.fn(),
    setUserPreferences: vi.fn(),
    compareAndSetExpansionFlags: vi.fn(),
  },
  start: vi.fn(),
  end: vi.fn(),
  getMyUser: vi.fn(),
}));
vi.mock("../repos", () => ({
  getUserPreferencesRepo: () => mocks.repo,
  getUserRepo: () => ({ getMyUser: mocks.getMyUser }),
}));
vi.mock("../actions/ephemeral-session.actions", () => ({
  startEphemeralSession: mocks.start,
  endEphemeralSession: mocks.end,
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    verbose: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }),
}));
import {
  createDefaultPreferences,
  refreshCurrentUser,
  updateUserPreferences,
} from "../actions/user.actions";
import {
  parseExpansionFlags,
  serializeExpansionFlags,
} from "../types/expansion-flags.types";
import { setExpansionFlag } from "./featureFlags";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

let row: UserPreferences;
beforeEach(() => {
  vi.resetAllMocks();
  row = createDefaultPreferences();
  setAppState(
    { ...structuredClone(INITIAL_APP_STATE), userPrefs: structuredClone(row) },
    true,
  );
  mocks.repo.getUserPreferences.mockImplementation(async () =>
    structuredClone(row),
  );
  mocks.repo.setUserPreferences.mockImplementation(
    async (value: UserPreferences) => {
      row = { ...value, expansionFlags: row.expansionFlags };
      return structuredClone(row);
    },
  );
  mocks.repo.compareAndSetExpansionFlags.mockImplementation(
    async (expected: string, flags: string) => {
      if (row.expansionFlags !== expected) return null;
      row = { ...row, expansionFlags: flags };
      return structuredClone(row);
    },
  );
  mocks.getMyUser.mockResolvedValue(null);
  mocks.start.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
});
afterEach(() => setAppState(structuredClone(INITIAL_APP_STATE), true));

it("keeps a flag change when an earlier whole-row save replies late", async () => {
  const reply = deferred<UserPreferences>();
  const started = deferred<void>();
  mocks.repo.setUserPreferences.mockImplementationOnce(
    (value: UserPreferences) => {
      row = { ...value, expansionFlags: row.expansionFlags };
      started.resolve();
      return reply.promise;
    },
  );
  const save = updateUserPreferences((preferences) => {
    preferences.preferredMicrophone = "new mic";
  });
  await started.promise;
  const oldReply = structuredClone(row);
  await setExpansionFlag("meetingNotesEnabled", true);
  reply.resolve(oldReply);
  await save;
  expect(getAppState().userPrefs?.preferredMicrophone).toBe("new mic");
  expect(
    JSON.parse(getAppState().userPrefs!.expansionFlags).meetingNotesEnabled,
  ).toBe(true);
  expect(JSON.parse(row.expansionFlags).meetingNotesEnabled).toBe(true);
});

it("keeps a newer preference when an older flag response arrives late", async () => {
  const reply = deferred<UserPreferences>();
  const started = deferred<void>();
  mocks.repo.compareAndSetExpansionFlags.mockImplementationOnce(
    (_expected: string, flags: string) => {
      row = { ...row, expansionFlags: flags };
      started.resolve();
      return reply.promise;
    },
  );
  const flag = setExpansionFlag("meetingNotesEnabled", true);
  await started.promise;
  const oldReply = structuredClone(row);
  await updateUserPreferences((preferences) => {
    preferences.preferredMicrophone = "new mic";
  });
  reply.resolve(oldReply);
  await flag;
  expect(getAppState().userPrefs?.preferredMicrophone).toBe("new mic");
  expect(
    JSON.parse(getAppState().userPrefs!.expansionFlags).meetingNotesEnabled,
  ).toBe(true);
  expect(row.preferredMicrophone).toBe("new mic");
});

it("does not start an ephemeral session for a retired account after a late flag write", async () => {
  const reply = deferred<UserPreferences>();
  const started = deferred<void>();
  mocks.repo.compareAndSetExpansionFlags.mockImplementationOnce(
    (_expected: string, flags: string) => {
      row = { ...row, expansionFlags: flags };
      started.resolve();
      return reply.promise;
    },
  );
  const flag = setExpansionFlag("ephemeralSessionEnabled", true);
  const outcome = flag.catch((error: unknown) => error);
  await started.promise;
  const successor = {
    ...createDefaultPreferences(),
    preferredMicrophone: "successor",
  };
  setAppState({ authSessionNonce: 1, userPrefs: successor });
  reply.resolve(structuredClone(row));
  expect(await outcome).toEqual(new Error("User session changed"));
  expect(getAppState().userPrefs).toEqual(successor);
  expect(mocks.start).not.toHaveBeenCalled();
});

it("does not restore an intermediate flag value after an on-off ABA race", async () => {
  row.expansionFlags = serializeExpansionFlags(
    parseExpansionFlags(row.expansionFlags),
  );
  setAppState({ userPrefs: structuredClone(row) });
  const flagReply = deferred<UserPreferences>();
  const flagStarted = deferred<void>();
  mocks.repo.compareAndSetExpansionFlags.mockImplementationOnce(
    (_expected: string, flags: string) => {
      row = { ...row, expansionFlags: flags };
      flagStarted.resolve();
      return flagReply.promise;
    },
  );
  const flagOn = setExpansionFlag("meetingNotesEnabled", true);
  await flagStarted.promise;
  const firstFlagReply = structuredClone(row);
  const saveReply = deferred<UserPreferences>();
  const saveStarted = deferred<void>();
  mocks.repo.setUserPreferences.mockImplementationOnce(
    (value: UserPreferences) => {
      row = { ...value, expansionFlags: row.expansionFlags };
      saveStarted.resolve();
      return saveReply.promise;
    },
  );
  const save = updateUserPreferences((preferences) => {
    preferences.preferredMicrophone = "new mic";
  });
  await saveStarted.promise;
  const staleSaveReply = structuredClone(row);
  flagReply.resolve(firstFlagReply);
  await flagOn;
  await setExpansionFlag("meetingNotesEnabled", false);
  saveReply.resolve(staleSaveReply);
  await save;
  expect(getAppState().userPrefs?.preferredMicrophone).toBe("new mic");
  expect(
    JSON.parse(getAppState().userPrefs!.expansionFlags).meetingNotesEnabled,
  ).toBe(false);
  expect(JSON.parse(row.expansionFlags).meetingNotesEnabled).toBe(false);
});

it("does not let an older refresh undo a flag change", async () => {
  const response = deferred<UserPreferences>();
  const started = deferred<void>();
  const oldRow = structuredClone(row);
  mocks.repo.getUserPreferences.mockImplementationOnce(() => {
    started.resolve();
    return response.promise;
  });
  const refresh = refreshCurrentUser();
  await started.promise;
  await setExpansionFlag("meetingNotesEnabled", true);
  response.resolve(oldRow);
  await refresh;
  expect(
    JSON.parse(getAppState().userPrefs!.expansionFlags).meetingNotesEnabled,
  ).toBe(true);
});

it("uses the current repository row when no newer local preferences were published", async () => {
  row.preferredMicrophone = "hydrated mic";
  // The existing state can be from before hydration, even if it is non-null.
  await setExpansionFlag("meetingNotesEnabled", true);
  expect(getAppState().userPrefs?.preferredMicrophone).toBe("hydrated mic");
});

it("does not dispatch a flag write after its session retires during the read", async () => {
  const response = deferred<UserPreferences>();
  const started = deferred<void>();
  mocks.repo.getUserPreferences.mockImplementationOnce(() => {
    started.resolve();
    return response.promise;
  });
  const flag = setExpansionFlag("meetingNotesEnabled", true);
  const outcome = flag.catch((error: unknown) => error);
  await started.promise;
  setAppState({ authSessionNonce: 1 });
  response.resolve(structuredClone(row));
  expect(await outcome).toEqual(new Error("User session changed"));
  expect(mocks.repo.compareAndSetExpansionFlags).not.toHaveBeenCalled();
});
