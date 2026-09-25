import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAppState } from "../store";
import {
  isEphemeralSessionActive,
  isIncognitoModeEnabled,
  isPersistenceAllowed,
} from "./incognito.utils";

vi.mock("../store");

const mockState = (state: {
  incognitoModeEnabled?: boolean;
  ephemeralSessionActive?: boolean;
}) => {
  (getAppState as ReturnType<typeof vi.fn>).mockReturnValue({
    userPrefs: { incognitoModeEnabled: state.incognitoModeEnabled ?? false },
    local: { ephemeralSessionActive: state.ephemeralSessionActive ?? false },
  });
};

describe("incognito.utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows persistence when incognito is off and no ephemeral session runs", () => {
    mockState({});

    expect(isIncognitoModeEnabled()).toBe(false);
    expect(isEphemeralSessionActive()).toBe(false);
    expect(isPersistenceAllowed()).toBe(true);
  });

  it("blocks persistence while incognito mode is on", () => {
    mockState({ incognitoModeEnabled: true });

    expect(isPersistenceAllowed()).toBe(false);
  });

  it("blocks persistence while an ephemeral session is active", () => {
    mockState({ ephemeralSessionActive: true });

    expect(isEphemeralSessionActive()).toBe(true);
    expect(isPersistenceAllowed()).toBe(false);
  });

  it("blocks persistence when both are on", () => {
    mockState({ incognitoModeEnabled: true, ephemeralSessionActive: true });

    expect(isPersistenceAllowed()).toBe(false);
  });

  it("treats missing preferences as incognito off", () => {
    (getAppState as ReturnType<typeof vi.fn>).mockReturnValue({
      userPrefs: undefined,
      local: { ephemeralSessionActive: false },
    });

    expect(isIncognitoModeEnabled()).toBe(false);
    expect(isPersistenceAllowed()).toBe(true);
  });
});
