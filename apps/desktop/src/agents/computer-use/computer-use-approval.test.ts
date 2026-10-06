// @vitest-environment jsdom
import type { ComputerUseAction } from "@maus-inc/types";
import { beforeEach, describe, expect, it } from "vitest";
import { produceAppState } from "../../store";
import { getAppState } from "../../store";
import { createDefaultPreferences } from "../../actions/user.actions";
import {
  getToolPermissionStatus,
  resolveToolPermission,
} from "../../actions/tool.actions";
import {
  computerUseToolId,
  requestComputerUseApproval,
} from "./computer-use-approval";
import {
  getToolAlwaysAllow,
  setToolAlwaysAllow,
} from "../../utils/tool-permission.utils";

/** Stand in for a user who has already answered this action type. */
const allowForever = (toolId: string, conversationId: string): void => {
  setToolAlwaysAllow(toolId, true, `conversation:${conversationId}`);
};

const click: ComputerUseAction = { type: "click", x: 10, y: 20 };
const type: ComputerUseAction = { type: "type", text: "hello" };

const request = (
  action: ComputerUseAction,
  over: Partial<{ summary: string; warning: string; risk: "high" }> = {},
) => ({
  action,
  risk: over.risk ?? ("high" as const),
  summary: over.summary ?? "Click 1 time at 10, 20 with the left button",
  ...(over.warning ? { warning: over.warning } : {}),
});

describe("stopping a run that is parked on a prompt", () => {
  beforeEach(() => {
    localStorage.clear();
    produceAppState((draft) => {
      draft.toolInfoById = {};
      draft.toolPermissionById = {};
    });
  });

  /**
   * Production never supplies an `AbortSignal`: `route-agent-run` calls the
   * runner with two arguments, so Stop reaches a run through `loop.abort()`.
   * A poll that only watched the signal therefore sat there for its whole
   * permission timeout, leaving the card on screen and the conversation
   * registered as running.
   */
  it("returns as soon as the run is told to stop, with no signal involved", async () => {
    let stopped = false;
    const started = Date.now();
    const pending = requestComputerUseApproval(request(click), {
      conversationId: "c-stop",
      isStopped: () => stopped,
    });

    // Let the poll reach its first status read, then stop the run.
    await new Promise((resolve) => setTimeout(resolve, 30));
    stopped = true;

    const outcome = await pending;
    expect(Date.now() - started).toBeLessThan(500);
    expect(outcome.answer).toBe("deny");
  });

  it("takes the prompt off screen rather than leaving it answerable", async () => {
    let stopped = false;
    const pending = requestComputerUseApproval(request(click), {
      conversationId: "c-stop",
      isStopped: () => stopped,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getAppState().toolPermissionById).not.toEqual({});
    const permissionId = Object.keys(getAppState().toolPermissionById)[0];
    stopped = true;
    await pending;

    // A prompt left pending invites an answer to a run that has already
    // stopped, and a later Allow would read as consent never acted on.
    expect(getToolPermissionStatus(permissionId)?.status).toBe("denied");
  });

  it("does not ask at all when the run is already stopped", async () => {
    const outcome = await requestComputerUseApproval(request(click), {
      conversationId: "c-stop",
      isStopped: () => true,
    });

    expect(outcome.answer).toBe("deny");
    expect(getAppState().toolPermissionById).toEqual({});
  });

  it("still stops on a signal for a caller that supplies one", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await requestComputerUseApproval(request(click), {
      conversationId: "c-stop",
      signal: controller.signal,
    });

    expect(outcome.answer).toBe("deny");
  });
});

describe("computer use approval", () => {
  beforeEach(() => {
    localStorage.clear();
    produceAppState((draft) => {
      draft.toolInfoById = {};
      draft.toolPermissionById = {};
      // Preferences are reset as well as the permission store. The timeout case
      // below shortens the shared timeout to prove the run does not wait
      // forever, and without this reset every later case in the file inherits a
      // one millisecond timeout and reads back as denied.
      draft.userPrefs = createDefaultPreferences();
    });
  });

  it("scopes the permission to the action type, not to computer use as a whole", () => {
    // Allowing clicks must not silently allow typing. A single id for the whole
    // capability would hand over the keyboard in the same click.
    expect(computerUseToolId(click)).not.toBe(computerUseToolId(type));
  });

  it("does not ask at all once the user has said always for that action type", async () => {
    allowForever(computerUseToolId(click), "c1");

    const answer = await requestComputerUseApproval(request(click), {
      conversationId: "c1",
    });

    expect(answer.answer).toBe("always");
    // No permission was registered, so no prompt reached the UI. Asserting on
    // the store rather than on a spy: the store is what the card reads.
    expect(getAppState().toolPermissionById).toEqual({});
  });

  it("still asks about a different action type under the same grant", async () => {
    allowForever(computerUseToolId(click), "c1");

    const promise = requestComputerUseApproval(request(type), {
      conversationId: "c1",
    });
    await Promise.resolve();
    const permissionId = Object.keys(getAppState().toolPermissionById)[0];
    resolveToolPermission(permissionId, "allowed");

    expect((await promise).answer).toBe("approve");
  });

  it("registers a plain-language description so the prompt is not a tool name", async () => {
    const promise = requestComputerUseApproval(
      request(click, { summary: "Click the Save button at 960, 540" }),
      { conversationId: "c1" },
    );
    await Promise.resolve();

    const toolId = computerUseToolId(click);
    expect(getAppState().toolInfoById[toolId].description).toBe(
      "Click the Save button at 960, 540",
    );

    const permissionId = Object.keys(getAppState().toolPermissionById)[0];
    resolveToolPermission(permissionId, "allowed");
    expect((await promise).answer).toBe("approve");
  });

  it("puts the warning in front of the user rather than only the action", async () => {
    const promise = requestComputerUseApproval(
      request(click, { warning: "This can delete a file." }),
      { conversationId: "c1" },
    );
    await Promise.resolve();

    const permissionId = Object.keys(getAppState().toolPermissionById)[0];
    const permission = getAppState().toolPermissionById[permissionId];
    expect(permission.params.reason).toContain("This can delete a file.");
    expect(permission.params.risk).toBe("high");

    resolveToolPermission(permissionId, "allowed");
    await promise;
  });

  it("reports a denial as a denial", async () => {
    const promise = requestComputerUseApproval(request(click), {
      conversationId: "c1",
    });
    await Promise.resolve();
    const permissionId = Object.keys(getAppState().toolPermissionById)[0];
    resolveToolPermission(permissionId, "denied");

    expect((await promise).answer).toBe("deny");
  });

  it("does not ask when the run was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const answer = await requestComputerUseApproval(request(click), {
      conversationId: "c1",
      signal: controller.signal,
    });

    expect(answer.answer).toBe("deny");
    expect(getAppState().toolPermissionById).toEqual({});
  });

  it("stops waiting and reports a denial when the run is aborted mid-prompt", async () => {
    const controller = new AbortController();
    const promise = requestComputerUseApproval(request(click), {
      conversationId: "c1",
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(Object.keys(getAppState().toolPermissionById)).toHaveLength(1);

    controller.abort();
    expect((await promise).answer).toBe("deny");
  });

  it("treats a missing permission as a denial rather than proceeding", async () => {
    // The permission store is the only record that anyone agreed. If the record
    // is gone, nobody did, and running the action would be the unsafe reading.
    const promise = requestComputerUseApproval(request(click), {
      conversationId: "c1",
    });
    await Promise.resolve();
    const permissionId = Object.keys(getAppState().toolPermissionById)[0];
    produceAppState((draft) => {
      delete draft.toolPermissionById[permissionId];
    });

    expect((await promise).answer).toBe("deny");
  });

  it("inherits the shared permission timeout rather than waiting forever", async () => {
    produceAppState((draft) => {
      draft.userPrefs = {
        ...createDefaultPreferences(),
        agentPermissionTimeoutMs: 1,
      };
    });
    const started = Date.now();

    const answer = await requestComputerUseApproval(request(click), {
      conversationId: "c1",
    });

    expect(answer.answer).toBe("deny");
    expect(
      getToolPermissionStatus(Object.keys(getAppState().toolPermissionById)[0])
        ?.status,
    ).toBe("denied");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not read a grant stored for a different action type", () => {
    allowForever(computerUseToolId(type), "c1");

    expect(
      getToolAlwaysAllow(computerUseToolId(click), "conversation:c1"),
    ).toBe(false);
  });

  it("files the prompt in the shared permission store, not a private queue", async () => {
    // The whole point of reusing this store is that the existing card, timeout
    // and always-allow behaviour apply unchanged. A private queue would be a
    // second permission system with its own holes, so the permission has to
    // appear in the store the card already reads.
    const promise = requestComputerUseApproval(request(click), {
      conversationId: "c1",
    });
    await Promise.resolve();

    const permissions = Object.values(getAppState().toolPermissionById);
    expect(permissions).toHaveLength(1);
    expect(permissions[0].toolId).toBe(computerUseToolId(click));
    expect(permissions[0].conversationId).toBe("c1");
    expect(permissions[0].status).toBe("pending");

    resolveToolPermission(permissions[0].id, "allowed");
    expect((await promise).answer).toBe("approve");
  });
});
