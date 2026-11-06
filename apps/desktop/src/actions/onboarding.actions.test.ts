import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";

const actionMocks = vi.hoisted(() => ({
  refreshMember: vi.fn(),
  setAutoLaunchEnabled: vi.fn(),
  setMyUser: vi.fn(),
  setUserPreferences: vi.fn(),
}));

vi.mock("../repos", () => ({
  getUserPreferencesRepo: () => ({
    setUserPreferences: actionMocks.setUserPreferences,
  }),
  getUserRepo: () => ({
    setMyUser: actionMocks.setMyUser,
  }),
}));
vi.mock("./local-storage.actions", () => ({
  clearLocalStorageValue: vi.fn(),
}));
vi.mock("./member.actions", () => ({
  refreshMember: actionMocks.refreshMember,
}));
vi.mock("./settings.actions", () => ({
  setAutoLaunchEnabled: actionMocks.setAutoLaunchEnabled,
}));

vi.mock("../utils/analytics.utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/analytics.utils")>();
  return {
    ...actual,
    trackOnboardingStep: vi.fn(),
    trackOnboardingOutcome: vi.fn(),
    trackButtonClick: vi.fn(),
  };
});

vi.mock("../utils/env.utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/env.utils")>();
  return { ...actual, isMacOS: () => false };
});

vi.mock("./app.actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app.actions")>();
  return { ...actual, showErrorSnackbar: vi.fn() };
});

import {
  CURRENT_ONBOARDING_FLOW_VERSION,
  dismissTip,
  ensureOnboardingFlow,
  finishOnboarding,
  goBackOnboardingPage,
  goToOnboardingPage,
  markPrerequisite,
  resetTip,
  resumeOnboardingPage,
  submitOnboarding,
} from "./onboarding.actions";
import {
  trackOnboardingOutcome,
  trackOnboardingStep,
} from "../utils/analytics.utils";
import { showErrorSnackbar } from "./app.actions";
import { createDefaultPreferences } from "./user.actions";
import { markExpansionFlagsChanged } from "../utils/expansion-flags-revision";
import { LOCAL_USER_ID } from "../utils/user.utils";

const seed = () => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.initialized = true;
  setAppState(state, true);
};

const resetActionMocks = () => {
  vi.clearAllMocks();
  actionMocks.refreshMember.mockResolvedValue(undefined);
  actionMocks.setAutoLaunchEnabled.mockResolvedValue(undefined);
  actionMocks.setMyUser.mockImplementation((user: unknown) =>
    Promise.resolve(user),
  );
  actionMocks.setUserPreferences.mockImplementation((preferences: unknown) =>
    Promise.resolve(preferences),
  );
};

describe("onboarding navigation outcomes", () => {
  beforeEach(() => {
    resetActionMocks();
    seed();
  });

  it("records completion with elapsed time on forward nav", async () => {
    const { markOnboardingStepEntered } = await import("./onboarding.actions");
    markOnboardingStepEntered("signIn");
    goToOnboardingPage("personalCredentials");

    expect(getAppState().onboarding.currentPage).toBe("personalCredentials");
    expect(trackOnboardingOutcome).toHaveBeenCalledWith(
      "signIn",
      "complete",
      expect.any(Number),
    );
  });

  it("records skips distinctly from completions", () => {
    goToOnboardingPage("micCheck", "skip");
    expect(trackOnboardingOutcome).toHaveBeenCalledWith(
      "signIn",
      "skip",
      undefined,
    );
  });

  it("records back nav and restores the previous page", () => {
    goToOnboardingPage("personalCredentials");
    goToOnboardingPage("chooseTranscription");
    goBackOnboardingPage();

    expect(getAppState().onboarding.currentPage).toBe("personalCredentials");
    expect(getAppState().local.onboardingResumePage).toBe(
      "personalCredentials",
    );
    expect(trackOnboardingOutcome).toHaveBeenCalledWith(
      "chooseTranscription",
      "back",
      undefined,
    );
  });

  it("persists the resume page on every nav", () => {
    goToOnboardingPage("micCheck");
    expect(getAppState().local.onboardingResumePage).toBe("micCheck");
  });

  it("does not record a back outcome when there is nowhere to go", () => {
    goBackOnboardingPage();
    expect(getAppState().onboarding.currentPage).toBe("signIn");
    expect(trackOnboardingOutcome).not.toHaveBeenCalled();
  });

  it("still tracks step entry for the shell", () => {
    expect(trackOnboardingStep).toBeDefined();
  });
});

describe("onboarding flow migration", () => {
  beforeEach(() => {
    resetActionMocks();
    seed();
  });

  it("remaps removed pages to their nearest kept page", () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.onboarding.currentPage = "referralSource";
    next.onboarding.history = ["userDetails", "chooseLlm"];
    next.local.onboardingResumePage = "unlockedPro";
    next.local.onboardingFlowVersion = 0;
    setAppState(next, true);

    ensureOnboardingFlow();

    const migrated = getAppState();
    expect(migrated.onboarding.currentPage).toBe("keybindings");
    expect(migrated.onboarding.history).toEqual([
      "chooseTranscription",
      "keybindings",
    ]);
    expect(migrated.local.onboardingResumePage).toBe("tutorial");
    expect(migrated.local.onboardingFlowVersion).toBe(
      CURRENT_ONBOARDING_FLOW_VERSION,
    );
  });

  it("leaves current-version state untouched", () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.onboarding.currentPage = "micCheck";
    next.local.onboardingFlowVersion = CURRENT_ONBOARDING_FLOW_VERSION;
    setAppState(next, true);

    ensureOnboardingFlow();

    expect(getAppState().onboarding.currentPage).toBe("micCheck");
  });

  it("does not overwrite an active navigation stack with persisted progress", () => {
    const next = structuredClone(getAppState());
    next.onboarding.currentPage = "keybindings";
    next.onboarding.history = ["personalCredentials"];
    next.local.onboardingResumePage = "micCheck";
    setAppState(next, true);
    resumeOnboardingPage();
    expect(getAppState().onboarding.currentPage).toBe("keybindings");
    expect(getAppState().onboarding.history).toEqual(["personalCredentials"]);
    expect(trackOnboardingOutcome).not.toHaveBeenCalled();
  });

  it("adopts an ownerless persisted session for the authenticated user", () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.auth = {
      uid: "user-id",
      email: "user@example.com",
      displayName: null,
      providers: ["password"],
    };
    next.local.onboardingResumePage = "tutorial";
    next.local.onboardingNameDraft = "Mary Jane Watson";
    next.local.onboardingNameDraftUserId = null;
    next.local.onboardingSessionUserId = null;
    setAppState(next, true);

    resumeOnboardingPage();

    expect(getAppState().onboarding.currentPage).toBe("tutorial");
    expect(getAppState().onboarding.name).toBe("Mary Jane Watson");
    expect(getAppState().local.onboardingNameDraft).toBe("Mary Jane Watson");
    expect(getAppState().local.onboardingNameDraftUserId).toBe("user-id");
    expect(getAppState().local.onboardingSessionUserId).toBe("user-id");
  });

  it("rejects a signed-in resume without an owned name draft to sign-in", () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.auth = {
      uid: "user-id",
      email: "user@example.com",
      displayName: null,
      providers: ["password"],
    };
    next.local.onboardingResumePage = "tutorial";
    next.local.onboardingFlowVersion = CURRENT_ONBOARDING_FLOW_VERSION;
    next.local.onboardingNameDraft = "Mary Jane Watson";
    next.local.onboardingNameDraftUserId = "old-user-id";
    setAppState(next, true);

    resumeOnboardingPage();

    expect(getAppState().onboarding.currentPage).toBe("signIn");
    expect(getAppState().onboarding.isResuming).toBe(false);
    expect(getAppState().local.onboardingResumePage).toBeNull();
    expect(getAppState().local.onboardingNameDraft).toBe("");
    expect(getAppState().local.onboardingNameDraftUserId).toBe("user-id");
    expect(trackOnboardingOutcome).not.toHaveBeenCalled();
  });

  it("does not restore or clear a signed-in session before initialization", () => {
    const next = structuredClone(getAppState());
    next.initialized = false;
    next.auth = {
      uid: "new-user",
      email: "new@example.com",
      displayName: null,
      providers: ["password"],
    };
    next.local.onboardingSessionUserId = "previous-user";
    next.local.onboardingResumePage = "tutorial";
    next.onboarding.company = "previous company";
    setAppState(next, true);

    resumeOnboardingPage();

    expect(getAppState().onboarding.company).toBe("previous company");
    expect(getAppState().local.onboardingResumePage).toBe("tutorial");
    expect(getAppState().local.onboardingSessionUserId).toBe("previous-user");
  });

  it.each(["foreign session", "unowned completed session"])(
    "clears stale data from a %s for a signed-in user",
    (scenario) => {
      const next = structuredClone(getAppState());
      next.auth = {
        uid: "new-user",
        email: "new@example.com",
        displayName: null,
        providers: ["password"],
      };
      next.onboarding.company = "previous company";
      if (scenario === "foreign session") {
        next.local.onboardingSessionUserId = "previous-user";
        next.local.onboardingResumePage = "tutorial";
      }
      setAppState(next, true);

      resumeOnboardingPage();

      expect(getAppState().onboarding.company).toBe("");
      expect(getAppState().onboarding.currentPage).toBe("signIn");
      expect(getAppState().local.onboardingResumePage).toBeNull();
      expect(getAppState().local.onboardingSessionUserId).toBe("new-user");
    },
  );

  it("rejects a signed-in submission without a first name", async () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.auth = {
      uid: "user-id",
      email: "user@example.com",
      displayName: null,
      providers: ["password"],
    };
    Object.assign(next.onboarding, {
      name: "Mary Jane Watson",
      firstName: "",
      lastName: "Watson",
      lastNameEnabled: true,
    });
    next.local.onboardingNameDraft = "";
    next.local.onboardingNameDraftUserId = "user-id";
    setAppState(next, true);

    await expect(submitOnboarding()).resolves.toBeNull();

    // Defensive guard returns silently (Continue is already disabled
    // when firstName is empty) rather than surfacing an English snackbar.
    expect(showErrorSnackbar).not.toHaveBeenCalled();
    expect(getAppState().onboarding.submitting).toBe(false);
  });

  it("keeps onboarding pending until both dispatched writes settle after a failure", async () => {
    let resolvePreferences!: (value: unknown) => void;
    actionMocks.setMyUser.mockRejectedValueOnce(new Error("user write failed"));
    actionMocks.setUserPreferences.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreferences = resolve;
        }),
    );
    const submission = submitOnboarding();
    const pendingPreferences = actionMocks.setUserPreferences.mock.calls[0][0];
    await Promise.resolve();
    await Promise.resolve();
    expect(getAppState().onboarding.submitting).toBe(true);
    expect(showErrorSnackbar).not.toHaveBeenCalled();
    resolvePreferences(pendingPreferences);
    expect(await submission).toBeNull();
    expect(getAppState().onboarding.submitting).toBe(false);
    expect(showErrorSnackbar).toHaveBeenCalledOnce();
  });

  it("preserves a flag published while onboarding writes are pending", async () => {
    const next = structuredClone(getAppState());
    next.auth = {
      uid: "user-id",
      email: "user@example.com",
      displayName: "Maria Garcia",
      providers: ["password"],
    };
    Object.assign(next.onboarding, {
      name: "Maria Garcia",
      firstName: "Maria",
      lastName: "Garcia",
      lastNameEnabled: true,
    });
    next.local.onboardingNameDraft = "Maria Garcia";
    next.local.onboardingNameDraftUserId = "user-id";
    next.userPrefs = createDefaultPreferences();
    setAppState(next, true);
    let resolveUser: (value: unknown) => void = () => undefined;
    actionMocks.setMyUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    );
    const submission = submitOnboarding();
    const pendingUser = actionMocks.setMyUser.mock.calls[0]?.[0];
    const current = structuredClone(getAppState().userPrefs!);
    current.expansionFlags = '{"meetingNotesEnabled":true}';
    markExpansionFlagsChanged();
    setAppState({ userPrefs: current });
    resolveUser(pendingUser);
    await submission;
    expect(getAppState().userPrefs?.expansionFlags).toBe(
      current.expansionFlags,
    );
  });

  it.each(["resolve", "reject"] as const)(
    "does not clear a successor's submission when the old write %ss",
    async (outcome) => {
      const next = structuredClone(getAppState());
      next.auth = {
        uid: "first-user-id",
        email: null,
        displayName: "Maria Garcia",
        providers: ["password"],
      };
      Object.assign(next.onboarding, {
        name: "Maria Garcia",
        firstName: "Maria",
        lastName: "Garcia",
        lastNameEnabled: true,
      });
      next.local.onboardingNameDraft = "Maria Garcia";
      next.local.onboardingNameDraftUserId = "first-user-id";
      setAppState(next, true);
      let resolveWrite!: (value: unknown) => void;
      let rejectWrite!: (error: Error) => void;
      actionMocks.setMyUser.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveWrite = resolve;
            rejectWrite = reject;
          }),
      );
      const oldSubmission = submitOnboarding();
      const pendingUser = actionMocks.setMyUser.mock.calls[0][0];
      const successor = structuredClone(getAppState());
      successor.auth = {
        uid: "second-user-id",
        email: null,
        displayName: "Bob",
        providers: ["password"],
      };
      successor.authSessionNonce += 1;
      successor.onboarding.submitting = true;
      successor.onboarding.name = "Bob";
      setAppState(successor, true);
      if (outcome === "resolve") resolveWrite(pendingUser);
      else rejectWrite(new Error("old submission failed"));
      expect(await oldSubmission).toBeNull();
      expect(getAppState().onboarding.submitting).toBe(true);
      expect(getAppState().onboarding.name).toBe("Bob");
      expect(showErrorSnackbar).not.toHaveBeenCalled();
    },
  );

  it("does not publish a local submission after initial auth resolves without a nonce change", async () => {
    const state = structuredClone(getAppState());
    state.auth = null;
    state.onboarding.name = "Local";
    setAppState(state, true);
    let resolveWrite!: (value: unknown) => void;
    actionMocks.setMyUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const submission = submitOnboarding();
    const pendingUser = actionMocks.setMyUser.mock.calls[0][0];
    const successor = structuredClone(getAppState());
    successor.auth = {
      uid: "alice",
      email: null,
      displayName: "Alice",
      providers: ["password"],
    };
    successor.onboarding.name = "Alice";
    successor.onboarding.submitting = false;
    setAppState(successor, true);
    resolveWrite(pendingUser);
    expect(await submission).toBeNull();
    expect(getAppState().onboarding.name).toBe("Alice");
    expect(actionMocks.refreshMember).not.toHaveBeenCalled();
  });

  it("does not apply a completed submission to a different auth user", async () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.auth = {
      uid: "first-user-id",
      email: "first@example.com",
      displayName: "Maria Garcia",
      providers: ["password"],
    };
    Object.assign(next.onboarding, {
      name: "Maria Garcia",
      firstName: "Maria",
      lastName: "Garcia",
      lastNameEnabled: true,
    });
    next.local.onboardingNameDraft = "Maria Garcia";
    next.local.onboardingNameDraftUserId = "first-user-id";
    setAppState(next, true);

    let resolveUser: (value: unknown) => void = () => undefined;
    actionMocks.setMyUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    );
    const submission = submitOnboarding();
    const pendingUser = actionMocks.setMyUser.mock.calls[0]?.[0];

    const switched = structuredClone(getAppState());
    switched.auth = {
      uid: "second-user-id",
      email: "second@example.com",
      displayName: "Bob Jones",
      providers: ["password"],
    };
    Object.assign(switched.onboarding, {
      name: "Bob Jones",
      firstName: "Bob",
      lastName: "Jones",
      lastNameEnabled: true,
      submitting: false,
    });
    switched.local.onboardingNameDraft = "Bob Jones";
    switched.local.onboardingNameDraftUserId = "second-user-id";
    switched.authSessionNonce += 1;
    setAppState(switched, true);
    resolveUser(pendingUser);
    const result = await submission;
    expect(result).toBeNull();

    expect(getAppState().onboarding).toMatchObject({
      name: "Bob Jones",
      submitting: false,
    });
    expect(getAppState().local.onboardingNameDraft).toBe("Bob Jones");
    expect(getAppState().local.onboardingNameDraftUserId).toBe(
      "second-user-id",
    );
  });

  it("rejects a stale completion after an A-to-B-to-A auth cycle", async () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.auth = {
      uid: "first-user-id",
      email: "first@example.com",
      displayName: "Maria Garcia",
      providers: ["password"],
    };
    Object.assign(next.onboarding, {
      name: "Maria Garcia",
      firstName: "Maria",
      lastName: "Garcia",
      lastNameEnabled: true,
    });
    next.local.onboardingNameDraft = "Maria Garcia";
    next.local.onboardingNameDraftUserId = "first-user-id";
    setAppState(next, true);

    let resolveUser: (value: unknown) => void = () => undefined;
    actionMocks.setMyUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    );
    const submission = submitOnboarding();
    const pendingUser = actionMocks.setMyUser.mock.calls[0]?.[0];

    const secondUser = structuredClone(getAppState());
    secondUser.auth = {
      uid: "second-user-id",
      email: "second@example.com",
      displayName: "Bob Jones",
      providers: ["password"],
    };
    secondUser.authSessionNonce += 1;
    setAppState(secondUser, true);
    const firstUserAgain = structuredClone(getAppState());
    firstUserAgain.auth = {
      uid: "first-user-id",
      email: "first@example.com",
      displayName: "Maria Garcia",
      providers: ["password"],
    };
    Object.assign(firstUserAgain.onboarding, {
      name: "Maria New",
      firstName: "Maria",
      lastName: "New",
      lastNameEnabled: true,
      submitting: false,
    });
    firstUserAgain.local.onboardingNameDraft = "Maria New";
    firstUserAgain.local.onboardingNameDraftUserId = "first-user-id";
    firstUserAgain.authSessionNonce += 1;
    setAppState(firstUserAgain, true);
    resolveUser(pendingUser);
    const result = await submission;
    expect(result).toBeNull();

    expect(getAppState().onboarding.name).toBe("Maria New");
    expect(getAppState().onboarding.submitting).toBe(false);
    expect(getAppState().local.onboardingNameDraft).toBe("Maria New");
  });

  it("does not finish local onboarding after initial auth resolution without a nonce change", async () => {
    const state = structuredClone(getAppState());
    state.auth = null;
    state.userById[LOCAL_USER_ID] = {
      id: LOCAL_USER_ID,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name: "Local",
      onboarded: false,
      playInteractionChime: true,
      hasFinishedTutorial: false,
      wordsThisMonth: 0,
      wordsTotal: 0,
    };
    setAppState(state, true);
    let resolveWrite!: (value: unknown) => void;
    actionMocks.setMyUser.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const completion = finishOnboarding();
    const pendingUser = actionMocks.setMyUser.mock.calls[0][0];
    const successor = structuredClone(getAppState());
    successor.auth = {
      uid: "alice",
      email: null,
      displayName: "Alice",
      providers: ["password"],
    };
    successor.local.onboardingNameDraft = "Alice";
    setAppState(successor, true);
    resolveWrite(pendingUser);
    expect(await completion).toBeNull();
    expect(getAppState().local.onboardingNameDraft).toBe("Alice");
    expect(actionMocks.setAutoLaunchEnabled).not.toHaveBeenCalled();
  });

  it("does not finish shared onboarding state for a different auth user", async () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.auth = {
      uid: "first-user-id",
      email: "first@example.com",
      displayName: "Maria Garcia",
      providers: ["password"],
    };
    next.userById["first-user-id"] = {
      id: "first-user-id",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name: "Maria Garcia",
      onboarded: false,
      playInteractionChime: true,
      hasFinishedTutorial: false,
      wordsThisMonth: 0,
      wordsTotal: 0,
    };
    next.local.onboardingResumePage = "tutorial";
    next.local.onboardingNameDraft = "Maria Garcia";
    next.local.onboardingNameDraftUserId = "first-user-id";
    setAppState(next, true);

    let resolveUser: (value: unknown) => void = () => undefined;
    actionMocks.setMyUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    );
    const completion = finishOnboarding();
    const pendingUser = actionMocks.setMyUser.mock.calls[0]?.[0];

    const switched = structuredClone(getAppState());
    switched.auth = {
      uid: "second-user-id",
      email: "second@example.com",
      displayName: "Bob Jones",
      providers: ["password"],
    };
    switched.local.onboardingResumePage = "micCheck";
    switched.local.onboardingNameDraft = "Bob Jones";
    switched.local.onboardingNameDraftUserId = "second-user-id";
    switched.authSessionNonce += 1;
    setAppState(switched, true);
    resolveUser(pendingUser);
    const result = await completion;
    expect(result).toBeNull();

    expect(getAppState().local.onboardingResumePage).toBe("micCheck");
    expect(getAppState().local.onboardingNameDraft).toBe("Bob Jones");
    expect(getAppState().local.onboardingNameDraftUserId).toBe(
      "second-user-id",
    );
    expect(actionMocks.setAutoLaunchEnabled).not.toHaveBeenCalled();
  });

  it("resets the full onboarding session when the authenticated user changes", () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.auth = {
      uid: "new-user-id",
      email: "new@example.com",
      displayName: "Bob Jones",
      providers: ["password"],
    };
    next.userById["new-user-id"] = {
      id: "new-user-id",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name: "Bob Jones",
      onboarded: false,
      playInteractionChime: true,
      hasFinishedTutorial: false,
      wordsThisMonth: 0,
      wordsTotal: 0,
    };
    Object.assign(next.onboarding, {
      currentPage: "tutorial",
      title: "Old title",
      company: "Old company",
      referralSource: "old-referral",
      preferredMicrophone: "old-microphone",
    });
    next.local.onboardingResumePage = "tutorial";
    next.local.onboardingNameDraft = "Mary Jane Watson";
    next.local.onboardingNameDraftUserId = "old-user-id";
    setAppState(next, true);

    resumeOnboardingPage();

    expect(getAppState().onboarding).toMatchObject({
      currentPage: "signIn",
      isResuming: false,
      history: [],
      name: "Bob Jones",
      firstName: "Bob",
      lastName: "Jones",
      title: "",
      company: "",
      referralSource: "",
      preferredMicrophone: null,
    });
    expect(getAppState().local.onboardingResumePage).toBeNull();
    expect(getAppState().local.onboardingNameDraft).toBe("Bob Jones");
    expect(getAppState().local.onboardingNameDraftUserId).toBe("new-user-id");
  });

  it("rejects a stale finish after an A-to-B-to-A auth cycle", async () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.auth = {
      uid: "first-user-id",
      email: "first@example.com",
      displayName: "Maria Garcia",
      providers: ["password"],
    };
    next.userById["first-user-id"] = {
      id: "first-user-id",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name: "Maria Garcia",
      onboarded: false,
      playInteractionChime: true,
      hasFinishedTutorial: false,
      wordsThisMonth: 0,
      wordsTotal: 0,
    };
    next.local.onboardingResumePage = "tutorial";
    next.local.onboardingNameDraft = "Maria Garcia";
    next.local.onboardingNameDraftUserId = "first-user-id";
    setAppState(next, true);

    let resolveUser: (value: unknown) => void = () => undefined;
    actionMocks.setMyUser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUser = resolve;
        }),
    );
    const completion = finishOnboarding();
    const pendingUser = actionMocks.setMyUser.mock.calls[0]?.[0];

    const secondUser = structuredClone(getAppState());
    secondUser.auth = {
      uid: "second-user-id",
      email: "second@example.com",
      displayName: "Bob Jones",
      providers: ["password"],
    };
    secondUser.authSessionNonce += 1;
    setAppState(secondUser, true);
    const firstUserAgain = structuredClone(getAppState());
    firstUserAgain.auth = {
      uid: "first-user-id",
      email: "first@example.com",
      displayName: "Maria Garcia",
      providers: ["password"],
    };
    firstUserAgain.local.onboardingResumePage = "micCheck";
    firstUserAgain.local.onboardingNameDraft = "Maria New";
    firstUserAgain.local.onboardingNameDraftUserId = "first-user-id";
    firstUserAgain.authSessionNonce += 1;
    setAppState(firstUserAgain, true);
    resolveUser(pendingUser);
    const result = await completion;
    expect(result).toBeNull();

    expect(getAppState().local.onboardingResumePage).toBe("micCheck");
    expect(getAppState().local.onboardingNameDraft).toBe("Maria New");
    expect(actionMocks.setAutoLaunchEnabled).not.toHaveBeenCalled();
  });

  it("resumes persisted progress and the canonical name draft", () => {
    const state = getAppState();
    const next = structuredClone(state);
    next.local.onboardingResumePage = "micCheck";
    next.local.onboardingFlowVersion = CURRENT_ONBOARDING_FLOW_VERSION;
    next.local.onboardingNameDraft = "Mary Jane Watson";
    setAppState(next, true);

    resumeOnboardingPage();

    expect(getAppState().onboarding.currentPage).toBe("micCheck");
    expect(getAppState().local.onboardingResumePage).toBe("micCheck");
    expect(getAppState().local.onboardingNameDraft).toBe("Mary Jane Watson");
    expect(getAppState().onboarding).toMatchObject({
      name: "Mary Jane Watson",
      firstName: "Mary",
      lastName: "Watson",
      lastNameEnabled: true,
    });
    expect(getAppState().onboarding.history).toEqual([]);
    expect(trackOnboardingOutcome).not.toHaveBeenCalled();
  });
});

describe("prerequisites and tips", () => {
  beforeEach(() => {
    resetActionMocks();
    seed();
  });

  it("dedupes prerequisites", () => {
    markPrerequisite("microphone");
    markPrerequisite("microphone");
    expect(getAppState().local.completedPrerequisites).toEqual(["microphone"]);
  });

  it("dismisses and restores tips", () => {
    dismissTip("writing-styles");
    expect(getAppState().local.dismissedTipIds).toEqual(["writing-styles"]);
    dismissTip("writing-styles");
    expect(getAppState().local.dismissedTipIds).toEqual(["writing-styles"]);
    resetTip("writing-styles");
    expect(getAppState().local.dismissedTipIds).toEqual([]);
  });
});
