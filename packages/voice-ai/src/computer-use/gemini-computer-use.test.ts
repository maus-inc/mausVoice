import { describe, expect, it, vi } from "vitest";
import type {
  ComputerUseActionResult,
  ComputerUseEnvironment,
  ComputerUseScreenshot,
  ComputerUseTurn,
} from "@maus-inc/types";
import type { CustomFetch } from "../types";
import { createGeminiComputerUseSession } from "./gemini-computer-use";

const DISPLAY_WIDTH = 1920;
const DISPLAY_HEIGHT = 1080;

/** A capture narrower than the display, the case that makes scaling matter. */
const CAPTURE: ComputerUseScreenshot = {
  data: "aW1hZ2U=",
  mimeType: "image/png",
  width: 1280,
  height: 720,
};

const interaction = (steps: unknown[]) => ({
  id: "interaction-1",
  steps,
});

const call = (name: string, args: Record<string, unknown>, id = "call-1") => ({
  type: "function_call",
  id,
  name,
  arguments: args,
});

const output = (text: string) => ({
  type: "model_output",
  content: [{ type: "text", text }],
});

/**
 * Records every request and answers with a scripted response per turn.
 *
 * The bodies are kept because most of what these adapters do is put a specific
 * shape on the wire, and a test that only reads the returned action cannot tell
 * a wrong request from a right one that arrived by luck.
 */
const scriptedTransport = (responses: unknown[]) => {
  const bodies: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  let index = 0;
  // The parameter is typed as `CustomFetch` rather than as a bare string so the
  // mock has the same signature the production call site passes, which is what
  // stops a mismatch here from reaching the test suite as a type error.
  const customFetch: CustomFetch = vi.fn(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const payload = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { customFetch, bodies, headers };
};

const startInput = {
  systemPrompt: "Drive the desktop.",
  goal: "Open the settings app.",
  screenshot: CAPTURE,
  displayWidth: DISPLAY_WIDTH,
  displayHeight: DISPLAY_HEIGHT,
};

const advanceInput = (
  results: ComputerUseActionResult[],
  overrides: Partial<typeof startInput> = {},
) => ({
  results,
  screenshot: CAPTURE,
  displayWidth: DISPLAY_WIDTH,
  displayHeight: DISPLAY_HEIGHT,
  ...overrides,
});

const result = (
  overrides: Partial<ComputerUseActionResult> & Pick<ComputerUseActionResult, "callId">,
): ComputerUseActionResult => ({
  providerName: "click",
  success: true,
  message: "OK",
  ...overrides,
});

const only = (turn: ComputerUseTurn) => turn.actions[0]?.action;

describe("gemini environment and interaction identity", () => {
  const open = (customFetch: CustomFetch, environment: ComputerUseEnvironment = "desktop") =>
    createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment,
      customFetch,
    });

  it("refuses an environment its action vocabulary cannot carry out", () => {
    // The member mapping is the desktop one and the vocabulary has no
    // `navigate`, so a browser session would ask the provider for a browser and
    // then refuse every browser action it returned.
    const transport = scriptedTransport([interaction([])]);

    expect(() => open(transport.customFetch, "browser")).toThrow(/desktop/);
    expect(() => open(transport.customFetch, "mobile")).toThrow(/desktop/);
  });

  it("says what this client can do rather than blaming another environment", () => {
    const transport = scriptedTransport([
      interaction([call("navigate", { url: "https://example.com" })]),
    ]);

    return open(transport.customFetch)
      .start(startInput)
      .then((turn) => {
        expect(turn.actions[0]?.action).toMatchObject({
          type: "unsupported",
          providerName: "navigate",
        });
        // The old wording claimed the action belonged to a different
        // environment than the one driving it, which is false when the
        // configured environment is the browser.
        expect(
          (turn.actions[0]?.action as { reason: string }).reason,
        ).toContain("this client drives the desktop");
      });
  });

  it("refuses a turn it cannot continue, rather than starting a fresh one", async () => {
    // A missing interaction id means the next turn would be posted with no
    // `previous_interaction_id`, so the provider answers as if nothing came
    // before it and the model re-does finished work.
    const transport = scriptedTransport([{ steps: [call("click", { x: 1, y: 1 })] }]);

    await expect(open(transport.customFetch).start(startInput)).rejects.toThrow(
      /no interaction id/,
    );
  });

  it("refuses an interaction id that is only whitespace", async () => {
    const transport = scriptedTransport([
      { id: "   ", steps: [call("click", { x: 1, y: 1 })] },
    ]);

    await expect(open(transport.customFetch).start(startInput)).rejects.toThrow(
      /no interaction id/,
    );
  });
});

describe("gemini computer use request shape", () => {
  it("declares the toolset and sends the goal beside the screenshot", async () => {
    const transport = scriptedTransport([interaction([call("click", { x: 500, y: 500 })])]);
    await createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    }).start(startInput);

    expect(transport.bodies[0]).toMatchObject({
      model: "gemini-3.8-flash",
      system_instruction: "Drive the desktop.",
      tools: [{ type: "computer_use", environment: "desktop" }],
    });
    expect(transport.bodies[0]?.input).toEqual([
      { type: "text", text: "Open the settings app." },
      { type: "image", data: CAPTURE.data, mime_type: "image/png" },
    ]);
  });

  it("authenticates with the header the endpoint expects", async () => {
    const transport = scriptedTransport([interaction([call("click", { x: 1, y: 1 })])]);
    await createGeminiComputerUseSession({
      apiKey: "  secret-key  ",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    }).start(startInput);

    // A trimmed key is what the endpoint needs. An untrimmed one is a 400 that
    // reads as an invalid credential rather than as stray whitespace.
    expect(transport.headers[0]?.["x-goog-api-key"]).toBe("secret-key");
  });

  it("continues the interaction it was given rather than resending history", async () => {
    const transport = scriptedTransport([
      interaction([call("click", { x: 500, y: 500 }, "call-1")]),
      { id: "interaction-2", steps: [output("done")] },
    ]);
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    });
    await session.start(startInput);
    await session.advance(
      advanceInput([result({ callId: "call-1" })]),
    );

    // The second turn names the first turn's interaction. There is no message
    // list to resend, which is what makes this provider's session state a
    // single string rather than an array.
    expect(transport.bodies[1]?.previous_interaction_id).toBe("interaction-1");
    expect(transport.bodies[1]).not.toHaveProperty("messages");
  });

  it("answers every call the previous turn made", async () => {
    const transport = scriptedTransport([
      interaction([
        call("click", { x: 500, y: 500 }, "call-1"),
        call("type", { text: "hello" }, "call-2"),
      ]),
      { id: "interaction-2", steps: [output("done")] },
    ]);
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    });
    await session.start(startInput);
    await session.advance(
      advanceInput([
        result({ callId: "call-1", providerName: "click" }),
        result({ callId: "call-2", providerName: "type" }),
      ]),
    );

    const input = transport.bodies[1]?.input as Array<Record<string, unknown>>;
    // A result the provider cannot match to its call rejects the whole
    // conversation, so the identifiers and names both have to survive.
    expect(input).toHaveLength(2);
    expect(input.map((entry) => entry.call_id)).toEqual(["call-1", "call-2"]);
    expect(input.map((entry) => entry.name)).toEqual(["click", "type"]);
  });

  it("carries the approval the provider demands after a confirmation", async () => {
    const transport = scriptedTransport([
      interaction([call("click", { x: 500, y: 500 }, "call-1")]),
      { id: "interaction-2", steps: [output("done")] },
    ]);
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    });
    await session.start(startInput);
    await session.advance(
      advanceInput([result({ callId: "call-1", userApproved: true })]),
    );

    const input = transport.bodies[1]?.input as Array<Record<string, unknown>>;
    const content = input[0]?.result as Array<Record<string, unknown>>;
    const payload = JSON.parse(String(content[0]?.text)) as Record<string, unknown>;
    expect(payload.safety_acknowledgement).toBe(true);
  });

  it("claims no approval when no user approved the action", async () => {
    const transport = scriptedTransport([
      interaction([call("click", { x: 500, y: 500 }, "call-1")]),
      { id: "interaction-2", steps: [output("done")] },
    ]);
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    });
    await session.start(startInput);
    await session.advance(
      advanceInput([result({ callId: "call-1", skipped: true })]),
    );

    const input = transport.bodies[1]?.input as Array<Record<string, unknown>>;
    const content = input[0]?.result as Array<Record<string, unknown>>;
    const payload = JSON.parse(String(content[0]?.text)) as Record<string, unknown>;
    // Claiming an approval nobody gave tells the provider its safety check
    // passed, which is the one thing this field must never do.
    expect(payload).not.toHaveProperty("safety_acknowledgement");
    expect(String(payload.outcome)).toContain("Skipped");
  });

  it("refuses to advance a conversation it never opened", async () => {
    const transport = scriptedTransport([interaction([call("click", { x: 1, y: 1 })])]);
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    });

    await expect(
      session.advance(advanceInput([result({ callId: "call-1" })])),
    ).rejects.toThrow(/before it started/);
    expect(transport.customFetch).not.toHaveBeenCalled();
  });

  it("rejects a JPEG capture instead of sending it", async () => {
    const transport = scriptedTransport([interaction([call("click", { x: 1, y: 1 })])]);
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    });

    await expect(
      session.start({ ...startInput, screenshot: { ...CAPTURE, mimeType: "image/jpeg" } }),
    ).rejects.toThrow(/PNG/);
    expect(transport.customFetch).not.toHaveBeenCalled();
  });
});

describe("gemini computer use action mapping", () => {
  const actionFor = async (name: string, args: Record<string, unknown>) => {
    const transport = scriptedTransport([interaction([call(name, args)])]);
    const turn = await createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    }).start(startInput);
    return only(turn);
  };

  it("converts a grid coordinate to a physical pixel", async () => {
    // x=500 on a 1000 wide grid is the middle of a 1920 wide display.
    expect(await actionFor("click", { x: 500, y: 500 })).toEqual({
      type: "click",
      x: 960,
      y: 540,
    });
  });

  it("waits a second when the provider omits the duration, as its own default says", async () => {
    // The desktop action table lists `seconds` as optional with a default of
    // one, so a bare wait is a real request. Refusing it spends a turn telling
    // the model it made a valid request.
    expect(await actionFor("wait", {})).toEqual({ type: "wait", ms: 1000 });
  });

  it("refuses a duration that is present but not a number", async () => {
    expect((await actionFor("wait", { seconds: "soon" })).type).toBe("unsupported");
  });

  it.each([
    ["negative", -100],
    ["past the grid", 1000],
  ])("refuses a %s scroll magnitude rather than scrolling by it", async (_why, magnitude) => {
    // The provider documents the magnitude as 0-999 on the coordinate grid. A
    // negative one would invert the scroll, and one past the grid asks for more
    // than the whole screen; the native layer stops both with an error that
    // names a number the model never chose.
    expect((await actionFor("scroll", { direction: "down", x: 500, y: 500, magnitude_in_pixels: magnitude })).type).toBe(
      "unsupported",
    );
  });

  it("uses the provider's own default magnitude when it omits one", async () => {
    const action = await actionFor("scroll", { direction: "down", x: 500, y: 500 });
    expect(action).toMatchObject({ type: "scroll", direction: "down" });
  });

  it("carries the press point through a press and release", async () => {
    // A press at a point and a release at a point are how a model drags
    // without asking for a drag, so the point has to survive both members. The
    // release alone dropping it starts the drag from wherever the pointer
    // happened to be.
    const transport = scriptedTransport([
      interaction([
        call("mouse_down", { x: 250, y: 500 }, "call-1"),
        call("mouse_up", { x: 500, y: 500 }, "call-2"),
      ]),
    ]);
    const turn = await createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    }).start(startInput);
    expect(turn.actions.map((action) => action.action)).toEqual([
      { type: "mouse_down", x: 480, y: 540 },
      { type: "mouse_up", x: 960, y: 540 },
    ]);
  });

  it("fails a turn whose call the provider did not identify", async () => {
    // A result has to name the call it answers, and the provider's own response
    // example includes a function_call with no id. Inventing one does not
    // answer the call, so the next turn is rejected with an error about a
    // malformed interaction rather than about the missing id.
    const transport = scriptedTransport([
      { id: "interaction-1", steps: [{ type: "function_call", name: "click", arguments: { x: 1, y: 1 } }] },
    ]);
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    });
    await expect(session.start(startInput)).rejects.toThrow(/no id/);
  });

  it("fails a turn whose identifier is only whitespace", async () => {
    const transport = scriptedTransport([
      { id: "interaction-1", steps: [call("click", { x: 1, y: 1 }, "   ")] },
    ]);
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    });
    await expect(session.start(startInput)).rejects.toThrow(/no id/);
  });

  it("converts a triple click's count", async () => {
    expect(await actionFor("triple_click", { x: 0, y: 0 })).toEqual({
      type: "click",
      x: 0,
      y: 0,
      clicks: 3,
    });
  });

  it("reads the mouse button a click names", async () => {
    expect(await actionFor("right_click", { x: 0, y: 0 })).toMatchObject({
      button: "right",
    });
  });

  it("keeps the press_enter flag the provider sent", async () => {
    expect(await actionFor("type", { text: "hello", press_enter: true })).toEqual({
      type: "type",
      text: "hello",
      pressEnter: true,
    });
  });

  it("converts both ends of a drag", async () => {
    expect(
      await actionFor("drag_and_drop", {
        start_x: 0,
        start_y: 0,
        end_x: 1000,
        end_y: 1000,
      }),
    ).toEqual({ type: "drag", fromX: 0, fromY: 0, toX: 1919, toY: 1079 });
  });

  it("converts seconds to milliseconds", async () => {
    expect(await actionFor("wait", { seconds: 2 })).toEqual({
      type: "wait",
      ms: 2000,
    });
  });

  it("converts a scroll magnitude against the display, not the grid", async () => {
    // 500 on a 1000 tall grid is half of a 1080 tall display.
    expect(
      await actionFor("scroll", {
        x: 500,
        y: 500,
        direction: "down",
        magnitude_in_pixels: 500,
      }),
    ).toEqual({ type: "scroll", direction: "down", amount: 540 });
  });

  it("scales a horizontal scroll by the width instead of the height", async () => {
    expect(
      await actionFor("scroll", {
        x: 500,
        y: 500,
        direction: "right",
        magnitude_in_pixels: 500,
      }),
    ).toMatchObject({ amount: 960 });
  });

  it("maps a key hold onto the vocabulary's hold action", async () => {
    expect(await actionFor("key_down", { key: "Shift" })).toEqual({
      type: "key_down",
      keys: ["Shift"],
    });
  });

  it("maps a key combination onto one key action", async () => {
    expect(await actionFor("hotkey", { keys: ["Control", "c"] })).toEqual({
      type: "key",
      keys: ["Control", "c"],
    });
  });

  it("refuses a click with no coordinate rather than clicking the corner", async () => {
    // The default for a missing coordinate would be zero, which is a real
    // click at the top left of the user's screen.
    expect(await actionFor("click", { intent: "click somewhere" })).toMatchObject({
      type: "unsupported",
    });
  });

  it("refuses a member that belongs to another environment", async () => {
    expect(await actionFor("navigate", { url: "https://example.com" })).toMatchObject({
      type: "unsupported",
      providerName: "navigate",
    });
  });

  it("carries the provider's stated reason without treating it as an argument", async () => {
    const transport = scriptedTransport([
      interaction([call("click", { x: 0, y: 0, intent: "Open the menu" })]),
    ]);
    const turn = await createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    }).start(startInput);

    expect(turn.actions[0]?.intent).toBe("Open the menu");
    expect(only(turn)).toEqual({ type: "click", x: 0, y: 0 });
  });

  it("surfaces a safety verdict so the loop can ask the user", async () => {
    const transport = scriptedTransport([
      interaction([
        call("click", {
          x: 0,
          y: 0,
          safety_decision: {
            decision: "require_confirmation",
            explanation: "This accepts a purchase",
          },
        }),
      ]),
    ]);
    const turn = await createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    }).start(startInput);

    expect(turn.actions[0]?.safety).toEqual({
      decision: "require_confirmation",
      explanation: "This accepts a purchase",
    });
  });

  it("reports no safety verdict rather than a default one", async () => {
    const transport = scriptedTransport([interaction([call("click", { x: 0, y: 0 })])]);
    const turn = await createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    }).start(startInput);

    // "regular" here would be a permission this adapter invented. Absent means
    // absent, which is what a caller reads as "nothing to gate on".
    expect(turn.actions[0]?.safety).toBeUndefined();
  });

  it("refuses to guess at a safety verdict it does not recognise", async () => {
    const transport = scriptedTransport([
      interaction([
        call("click", {
          x: 0,
          y: 0,
          safety_decision: { decision: "escalate_to_human" },
        }),
      ]),
    ]);
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    });

    // Reading an unknown verdict as "no verdict" is indistinguishable from a
    // call that carried none, so a refusal the app failed to parse would
    // quietly become something nobody was asked to approve.
    await expect(session.start(startInput)).rejects.toThrow(
      /safety decision this app does not understand: escalate_to_human/,
    );
  });

  it("reads prose alongside the calls it made", async () => {
    const transport = scriptedTransport([
      interaction([output("Opening the menu."), call("click", { x: 0, y: 0 })]),
    ]);
    const turn = await createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    }).start(startInput);

    expect(turn.text).toBe("Opening the menu.");
    expect(turn.actions).toHaveLength(1);
  });

  it("rejects a turn that carries neither a call nor prose", async () => {
    const transport = scriptedTransport([interaction([])]);
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch: transport.customFetch,
    });

    // Treating this as a finished task would end the run with no explanation of
    // what the model thought it was doing.
    await expect(session.start(startInput)).rejects.toThrow(/neither an action nor a message/);
  });
});

describe("gemini computer use failures", () => {
  it("does not reissue a request the provider rejected", async () => {
    const customFetch: CustomFetch = vi.fn(
      async () =>
        new Response("bad request", {
          status: 400,
          headers: { "content-type": "text/plain" },
        }),
    );
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch,
    });

    await expect(session.start(startInput)).rejects.toThrow(/Gemini responded 400/);
    // A rejected request costs money every time it is sent. Three identical
    // rejections is three charges for one mistake.
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("reissues a request the provider failed transiently", async () => {
    const customFetch: CustomFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(interaction([call("click", { x: 0, y: 0 })])), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const turn = await createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch,
    }).start(startInput);

    expect(customFetch).toHaveBeenCalledTimes(2);
    expect(turn.actions).toHaveLength(1);
  });

  it("stops immediately when the caller aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const customFetch: CustomFetch = vi.fn(async () => new Response("busy", { status: 503 }));
    const session = createGeminiComputerUseSession({
      apiKey: "key",
      model: "gemini-3.8-flash",
      environment: "desktop",
      customFetch,
    });

    await expect(session.start(startInput, controller.signal)).rejects.toThrow();
    // Reissuing a request the user just cancelled restarts the action they
    // cancelled.
    expect(customFetch).not.toHaveBeenCalled();
  });
});