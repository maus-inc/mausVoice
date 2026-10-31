import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { User } from "@maus-inc/types";
import { seedManualStyles, tone } from "../../test/helpers/tone-test.utils";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, produceAppState, setAppState } from "../store";
import { LOCAL_USER_ID } from "../utils/user.utils";

const repos = vi.hoisted(() => ({
  save: vi.fn<(user: User) => Promise<User>>(),
  load: vi.fn<() => Promise<User | null>>(),
}));
vi.mock("../repos", () => ({
  getUserRepo: () => ({ setMyUser: repos.save, getMyUser: repos.load }),
  getUserPreferencesRepo: () => ({}),
}));
vi.mock("../utils/log.utils", () => ({
  getLogger: () => ({ verbose: vi.fn(), warning: vi.fn(), error: vi.fn() }),
}));
import { setUserName, toggleActiveTone } from "./user.actions";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const active = () => getAppState().userById[LOCAL_USER_ID]!.activeToneIds!;
beforeEach(() => {
  vi.clearAllMocks();
  seedManualStyles("default");
  produceAppState((draft) => {
    draft.userById[LOCAL_USER_ID]!.activeToneIds = ["default"];
    draft.toneById.formal = tone("formal", "Formal");
  });
  repos.save.mockImplementation(async (user) => user);
  repos.load.mockResolvedValue(null);
});
afterEach(() => setAppState(structuredClone(INITIAL_APP_STATE), true));

it("applies three rapid toggles to the latest queued user, without losing an earlier choice", async () => {
  const pending = deferred<User>();
  repos.save.mockReturnValueOnce(pending.promise);
  const first = toggleActiveTone("email");
  const second = toggleActiveTone("chat");
  const third = toggleActiveTone("formal");
  await Promise.resolve();
  expect(repos.save).toHaveBeenCalledTimes(1);
  pending.resolve(repos.save.mock.calls[0][0]);
  await Promise.all([first, second, third]);
  expect(new Set(active())).toEqual(
    new Set(["default", "email", "chat", "formal"]),
  );
  expect(repos.save).toHaveBeenCalledTimes(3);
});

it("preserves other queued profile updates and two toggles of the same style", async () => {
  const pending = deferred<User>();
  repos.save.mockReturnValueOnce(pending.promise);
  const name = setUserName("New name");
  const add = toggleActiveTone("chat");
  const remove = toggleActiveTone("chat");
  await Promise.resolve();
  pending.resolve(repos.save.mock.calls[0][0]);
  await Promise.all([name, add, remove]);
  expect(getAppState().userById[LOCAL_USER_ID]?.name).toBe("New name");
  expect(active()).toEqual(["default"]);
});

it("never removes the last remaining style or adds a style deleted before its queued turn", async () => {
  const pending = deferred<User>();
  repos.save.mockReturnValueOnce(pending.promise);
  const first = toggleActiveTone("default");
  const later = toggleActiveTone("chat");
  await Promise.resolve();
  produceAppState((draft) => {
    delete draft.toneById.chat;
  });
  pending.resolve(repos.save.mock.calls[0][0]);
  await Promise.all([first, later]);
  expect(active()).toEqual(["default"]);
});

it("continues later intents from the reloaded user after a save fails", async () => {
  const committed = structuredClone(getAppState().userById[LOCAL_USER_ID]!);
  const pending = deferred<User>();
  repos.save.mockReturnValueOnce(pending.promise);
  repos.load.mockResolvedValueOnce(committed);
  const first = toggleActiveTone("email");
  const second = toggleActiveTone("chat");
  await Promise.resolve();
  pending.reject(new Error("disk full"));
  await expect(first).rejects.toThrow("disk full");
  await second;
  expect(new Set(active())).toEqual(new Set(["default", "chat"]));
  expect(getAppState().snackbarMode).toBe("error");
});
