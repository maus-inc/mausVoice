import { describe, expect, it } from "vitest";
import {
  clearOnboardingLastName,
  createOnboardingNameDraft,
  isOnboardingNameDraftOwnedByAuth,
  resolveOnboardingName,
  updateOnboardingFirstName,
  updateOnboardingLastName,
} from "./onboarding.state";

describe("onboarding name draft", () => {
  it("accepts legacy drafts without an owner", () => {
    expect(isOnboardingNameDraftOwnedByAuth(null, "user-id")).toBe(true);
  });

  it("accepts drafts owned by the current user", () => {
    expect(isOnboardingNameDraftOwnedByAuth("user-id", "user-id")).toBe(true);
  });

  it("rejects drafts owned by another user", () => {
    expect(isOnboardingNameDraftOwnedByAuth("other-id", "user-id")).toBe(false);
    expect(isOnboardingNameDraftOwnedByAuth("other-id", null)).toBe(false);
  });

  it("hydrates every field from a full name", () => {
    expect(createOnboardingNameDraft("Mary Jane Watson")).toEqual({
      name: "Mary Jane Watson",
      firstName: "Mary",
      lastName: "Watson",
      lastNameEnabled: true,
    });
  });

  it("clears the last-name projection for a first-only name", () => {
    expect(createOnboardingNameDraft("Mary")).toEqual({
      name: "Mary",
      firstName: "Mary",
      lastName: "",
      lastNameEnabled: false,
    });
  });

  it("preserves middle and multi-token surname parts on first-name edits", () => {
    const draft = createOnboardingNameDraft("Mary Jane Watson");

    expect(updateOnboardingFirstName(draft, "Maria")).toEqual({
      name: "Maria Jane Watson",
      firstName: "Maria",
      lastName: "Watson",
      lastNameEnabled: true,
    });
  });

  it("keeps the canonical name while the required first name is empty", () => {
    const draft = createOnboardingNameDraft("Mary Jane Watson");

    expect(updateOnboardingFirstName(draft, "")).toMatchObject({
      name: "Mary Jane Watson",
      firstName: "",
    });
  });

  it("replaces only the final token on last-name edits", () => {
    const draft = createOnboardingNameDraft("Mary Jane Watson");

    expect(updateOnboardingLastName(draft, "Smith")).toEqual({
      name: "Mary Jane Smith",
      firstName: "Mary",
      lastName: "Smith",
      lastNameEnabled: true,
    });
  });

  it("keeps a last name entered before the first name", () => {
    const lastNameDraft = updateOnboardingLastName(
      createOnboardingNameDraft(""),
      "Watson",
    );

    expect(updateOnboardingFirstName(lastNameDraft, "Mary")).toEqual({
      name: "Mary Watson",
      firstName: "Mary",
      lastName: "Watson",
      lastNameEnabled: true,
    });
  });

  it("resolves the canonical name before the persisted draft", () => {
    const draft = createOnboardingNameDraft("Mary Jane Watson");

    expect(resolveOnboardingName(draft, "Mary Watson")).toBe(
      "Mary Jane Watson",
    );
  });

  it("uses the persisted draft after rehydration", () => {
    const draft = createOnboardingNameDraft("");

    expect(resolveOnboardingName(draft, "Mary Jane Watson")).toBe(
      "Mary Jane Watson",
    );
  });

  it("falls back to enabled input fields for legacy drafts", () => {
    const draft = {
      name: "",
      firstName: "Mary",
      lastName: "Watson",
      lastNameEnabled: true,
    };

    expect(resolveOnboardingName(draft, "")).toBe("Mary Watson");
  });

  it("clearOnboardingLastName preserves middle names the real flow keeps", () => {
    // Mirror the real blur path: type a full name into last-name then clear
    // it, which runs updateOnboardingLastName("") first, then clear helper.
    const base = createOnboardingNameDraft("Mary Jane Watson Smith");
    const afterClear = updateOnboardingLastName(base, "");
    const released = clearOnboardingLastName(afterClear);
    // "Mary Jane Watson Smith" with last-name cleared to "" becomes
    // "Mary Jane Watson"; clear helper must not strip another token.
    expect(released.name).toBe("Mary Jane Watson");
    expect(released.firstName).toBe("Mary");
    expect(released.lastName).toBe("");
    expect(released.lastNameEnabled).toBe(false);
  });

  it("clearOnboardingLastName falls back to firstName when name is empty", () => {
    const draft = {
      name: "",
      firstName: "Madonna",
      lastName: "",
      lastNameEnabled: true,
    };
    const released = clearOnboardingLastName(draft);
    expect(released.name).toBe("Madonna");
    expect(released.lastName).toBe("");
    expect(released.lastNameEnabled).toBe(false);
  });
});
