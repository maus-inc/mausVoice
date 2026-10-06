import { describe, expect, it, vi } from "vitest";
import type {
  ComputerUseActionResult,
  ComputerUseScreenshot,
  ComputerUseTurn,
} from "@maus-inc/types";
import type { CustomFetch } from "../types";
import { createAnthropicComputerUseSession } from "./anthropic-computer-use";

const DISPLAY_WIDTH = 1920;
const DISPLAY_HEIGHT = 1080;

/**
 * A capture narrower than the display. This provider's coordinates are pixels
 * inside the image, so every position in these tests has to be read against
 * 1280x720 rather than against the screen.
 */
const CAPTURE: ComputerUseScreenshot = {
  data: "aW1hZ2U=",
  mimeType: "image/png",
  width: 1280,
  height: 720,
};

const message = (blocks: unknown[]) => ({ content: blocks });

const use = (
  name: string,
  input: Record<string, unknown>,
  id = "toolu_1",
) => ({
  type: "tool_use",
  id,
  name,
  toolset_name: "computer",
  input,
});

const text = (value: string) => ({ type: "text", text: value });

const scriptedTransport = (responses: unknown[]) => {
  const bodies: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  let index = 0;
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

const result = (
  overrides: Partial<ComputerUseActionResult> &
    Pick<ComputerUseActionResult, "callId" | "providerName">,
): ComputerUseActionResult => ({
  success: true,
  message: "OK",
  ...overrides,
});

const advanceInput = (results: ComputerUseActionResult[]) => ({
  results,
  screenshot: CAPTURE,
  displayWidth: DISPLAY_WIDTH,
  displayHeight: DISPLAY_HEIGHT,
});

const only = (turn: ComputerUseTurn) => turn.actions[0]?.action;

const openSession = (customFetch: CustomFetch) =>
  createAnthropicComputerUseSession({
    apiKey: "key",
    model: "claude-opus-5-5",
    customFetch,
  });

describe("anthropic result payload", () => {
  const lastUserBlocks = (
    body: Record<string, unknown>,
  ): { type: string; content?: { type: string }[] }[] =>
    (body.messages as { role: string; content: unknown }[])
      .filter((entry) => entry.role === "user")
      .flatMap(
        (entry) =>
          entry.content as { type: string; content?: { type: string }[] }[],
      )
      .slice(-2);

  it("gives a zoom that is not last in the batch the image it asked for", async () => {
    // The provider documents that a `zoom` result needs pixels. Attaching the
    // capture only to the final block answers a mid-batch zoom with a sentence
    // about pixel dimensions and no image, which is the one member where the
    // model is asking to see something and gets told about it instead.
    const transport = scriptedTransport([
      message([
        use("zoom", { region: [0, 0, 100, 100] }, "toolu_zoom"),
        use("left_click", { coordinate: [10, 10] }, "toolu_click"),
      ]),
      message([text("done")]),
    ]);
    const session = openSession(transport.customFetch);
    await session.start(startInput);
    await session.advance(
      advanceInput([
        result({ callId: "toolu_zoom", providerName: "zoom" }),
        result({ callId: "toolu_click", providerName: "left_click" }),
      ]),
    );

    const blocks = lastUserBlocks(transport.bodies[1] ?? {});
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.content?.some((part) => part.type === "image")).toBe(true);
  });

  it("sends the token budget this client is built to request", async () => {
    // A wire parameter the shape tests never pinned: lowering it is how a run
    // starts failing mid-answer with a provider-side truncation error.
    const transport = scriptedTransport([
      message([use("left_click", { coordinate: [100, 100] })]),
    ]);
    await openSession(transport.customFetch).start(startInput);

    expect(transport.bodies[0]?.max_tokens).toBe(4096);
  });
});

describe("anthropic computer use request shape", () => {
  it("declares the toolset and no beta header", async () => {
    const transport = scriptedTransport([message([use("left_click", { coordinate: [100, 100] })])]);
    await openSession(transport.customFetch).start(startInput);

    expect(transport.bodies[0]?.tools).toEqual([
      { type: "computer_toolset_20260801" },
    ]);
    // The toolset is GA. A beta header aimed at the older tool version is
    // rejected outright, and the display-size parameters that version required
    // are rejected by this one.
    expect(transport.headers[0]).not.toHaveProperty("anthropic-beta");
    expect(transport.bodies[0]).not.toHaveProperty("display_width_px");
  });

  it("authenticates and versions the request", async () => {
    const transport = scriptedTransport([message([use("left_click", { coordinate: [1, 1] })])]);
    await openSession(transport.customFetch).start(startInput);

    expect(transport.headers[0]?.["x-api-key"]).toBe("key");
    expect(transport.headers[0]?.["anthropic-version"]).toBe("2023-06-01");
  });

  it("withholds a member this client cannot perform", async () => {
    const transport = scriptedTransport([message([use("left_click", { coordinate: [1, 1] })])]);
    await createAnthropicComputerUseSession({
      apiKey: "key",
      model: "claude-opus-5-5",
      disabledMembers: ["zoom"],
      customFetch: transport.customFetch,
    }).start(startInput);

    // Withholding is how a missing capability is expressed. Leaving a member
    // enabled and answering its calls with errors spends a turn per call.
    expect(transport.bodies[0]?.tools).toEqual([
      {
        type: "computer_toolset_20260801",
        configs: { zoom: { enabled: false } },
      },
    ]);
  });

  it("resends the conversation rather than naming a session", async () => {
    const transport = scriptedTransport([
      message([use("left_click", { coordinate: [10, 10] }, "toolu_1")]),
      message([text("done")]),
    ]);
    const session = openSession(transport.customFetch);
    await session.start(startInput);
    await session.advance(advanceInput([result({ callId: "toolu_1", providerName: "left_click" })]));

    const second = transport.bodies[1]?.messages as Array<Record<string, unknown>>;
    // This provider keeps no server-side conversation, so the whole history
    // goes out each turn. That is the structural difference the session
    // interface exists to hide.
    expect(second).toHaveLength(3);
    expect(transport.bodies[1]).not.toHaveProperty("previous_interaction_id");
  });

  it("quotes the assistant turn back verbatim", async () => {
    const transport = scriptedTransport([
      message([use("left_click", { coordinate: [10, 10] }, "toolu_1")]),
      message([text("done")]),
    ]);
    const session = openSession(transport.customFetch);
    await session.start(startInput);
    await session.advance(advanceInput([result({ callId: "toolu_1", providerName: "left_click" })]));

    const messages = transport.bodies[1]?.messages as Array<Record<string, unknown>>;
    const assistant = messages[1]?.content as unknown[];
    // Rebuilt from the portable actions it would lose anything the provider
    // sent that the vocabulary has no name for, and the next request would be
    // rejected for a history it does not recognise.
    expect(assistant).toEqual([
      { type: "tool_use", id: "toolu_1", name: "left_click", toolset_name: "computer", input: { coordinate: [10, 10] } },
    ]);
  });

  it("puts the instruction before the image in the opening turn", async () => {
    const transport = scriptedTransport([message([use("left_click", { coordinate: [1, 1] })])]);
    await openSession(transport.customFetch).start(startInput);

    const messages = transport.bodies[0]?.messages as Array<Record<string, unknown>>;
    const content = messages[0]?.content as Array<Record<string, unknown>>;
    // Naming the target before showing the pixels measurably improves where
    // the model clicks.
    expect(content[0]).toEqual({ type: "text", text: "Open the settings app." });
    expect(content[1]).toMatchObject({ type: "image" });
  });

  it("reads every call out of a batch, in order", async () => {
    const transport = scriptedTransport([
      message([
        use("left_click", { coordinate: [10, 10] }, "toolu_1"),
        use("type", { text: "cats" }, "toolu_2"),
        use("screenshot", {}, "toolu_3"),
      ]),
      message([text("done")]),
    ]);
    const turn = await openSession(transport.customFetch).start(startInput);

    // This is the assertion that matters before the request-shape ones. Every
    // downstream batch assertion reads results the caller supplies, so they all
    // stay green even if the adapter stopped reading the second and third
    // calls. The loop's only source of what to run is this list.
    expect(turn.actions.map((action) => action.callId)).toEqual([
      "toolu_1",
      "toolu_2",
      "toolu_3",
    ]);
    expect(turn.actions.map((action) => action.providerName)).toEqual([
      "left_click",
      "type",
      "screenshot",
    ]);
    expect(turn.actions.map((action) => action.action.type)).toEqual([
      "click",
      "type",
      "screenshot",
    ]);
  });

  it("echoes the toolset marker on every result", async () => {
    const transport = scriptedTransport([
      message([use("left_click", { coordinate: [10, 10] }, "toolu_1")]),
      message([text("done")]),
    ]);
    const session = openSession(transport.customFetch);
    await session.start(startInput);
    await session.advance(advanceInput([result({ callId: "toolu_1", providerName: "left_click" })]));

    const messages = transport.bodies[1]?.messages as Array<Record<string, unknown>>;
    const content = messages[2]?.content as Array<Record<string, unknown>>;
    // A result that omits the marker, or names a different toolset, is
    // rejected outright rather than merely ignored.
    expect(content[0]).toMatchObject({ toolset_name: "computer" });
  });

  it("answers every call in the batch", async () => {
    const transport = scriptedTransport([
      message([
        use("left_click", { coordinate: [10, 10] }, "toolu_1"),
        use("type", { text: "cats" }, "toolu_2"),
        use("screenshot", {}, "toolu_3"),
      ]),
      message([text("done")]),
    ]);
    const session = openSession(transport.customFetch);
    await session.start(startInput);
    await session.advance(
      advanceInput([
        result({ callId: "toolu_1", providerName: "left_click" }),
        result({ callId: "toolu_2", providerName: "type" }),
        result({ callId: "toolu_3", providerName: "screenshot" }),
      ]),
    );

    const messages = transport.bodies[1]?.messages as Array<Record<string, unknown>>;
    const content = messages[2]?.content as Array<Record<string, unknown>>;
    // A batch with an unanswered call is rejected on the next request, so a
    // loop that read only the first action fails one turn later with an error
    // that says nothing about the cause.
    expect(content.map((block) => block.tool_use_id)).toEqual([
      "toolu_1",
      "toolu_2",
      "toolu_3",
    ]);
  });

  it("attaches the screen to the last result when nothing in the batch asked", async () => {
    const transport = scriptedTransport([
      message([use("left_click", { coordinate: [10, 10] }, "toolu_1")]),
      message([text("done")]),
    ]);
    const session = openSession(transport.customFetch);
    await session.start(startInput);
    await session.advance(advanceInput([result({ callId: "toolu_1", providerName: "left_click" })]));

    const messages = transport.bodies[1]?.messages as Array<Record<string, unknown>>;
    const content = messages[2]?.content as Array<Record<string, unknown>>;
    // Attaching it saves the turn the model would otherwise spend asking.
    expect(content[0]?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
  });

  it("reports a failure as an error result rather than a text one", async () => {
    const transport = scriptedTransport([
      message([use("left_click", { coordinate: [10, 10] }, "toolu_1")]),
      message([text("done")]),
    ]);
    const session = openSession(transport.customFetch);
    await session.start(startInput);
    await session.advance(
      advanceInput([
        result({ callId: "toolu_1", providerName: "left_click", success: false, message: "the window vanished" }),
      ]),
    );

    const messages = transport.bodies[1]?.messages as Array<Record<string, unknown>>;
    const content = messages[2]?.content as Array<Record<string, unknown>>;
    expect(content[0]?.is_error).toBe(true);
    expect(JSON.stringify(content[0]?.content)).toContain("the window vanished");
  });

  it("answers every action after a failure with the provider's skip sentence", async () => {
    // The sentence has to be produced here, not passed in. The provider reads
    // it to know an action was skipped rather than attempted, and the case that
    // matters is a caller that reported a later action as having run after an
    // earlier one failed: the provider halts the batch at the first failure, so
    // a result claiming success for a step it never reached sends the model
    // planning from a screen state it did not produce.
    const transport = scriptedTransport([
      message([
        use("left_click", { coordinate: [10, 10] }, "toolu_1"),
        use("left_click", { coordinate: [20, 20] }, "toolu_2"),
      ]),
      message([text("done")]),
    ]);
    const session = openSession(transport.customFetch);
    await session.start(startInput);
    await session.advance(
      advanceInput([
        result({
          callId: "toolu_1",
          providerName: "left_click",
          success: false,
          message: "the window vanished",
        }),
        result({
          callId: "toolu_2",
          providerName: "left_click",
          success: true,
          message: "clicked",
        }),
      ]),
    );

    const messages = transport.bodies[1]?.messages as Array<Record<string, unknown>>;
    const content = messages[2]?.content as Array<Record<string, unknown>>;
    const failed = content[0]?.content as Array<Record<string, unknown>>;
    const skipped = content[1]?.content as Array<Record<string, unknown>>;
    // The literal sentence, not the exported constant: rewording the constant
    // would move both sides of that comparison and leave the suite green while
    // the provider stopped recognising the sentinel.
    expect(failed[0]?.text).toContain("the window vanished");
    expect(skipped[0]?.text).toBe(
      "Not executed: an earlier computer action in this turn failed.",
    );
  });

  it("answers a whole successful batch with each result's own message", async () => {
    const transport = scriptedTransport([
      message([
        use("left_click", { coordinate: [10, 10] }, "toolu_1"),
        use("left_click", { coordinate: [20, 20] }, "toolu_2"),
      ]),
      message([text("done")]),
    ]);
    const session = openSession(transport.customFetch);
    await session.start(startInput);
    await session.advance(
      advanceInput([
        result({ callId: "toolu_1", providerName: "left_click", success: true, message: "clicked once" }),
        result({ callId: "toolu_2", providerName: "left_click", success: true, message: "clicked twice" }),
      ]),
    );

    const messages = transport.bodies[1]?.messages as Array<Record<string, unknown>>;
    const content = messages[2]?.content as Array<Record<string, unknown>>;
    const first = content[0]?.content as Array<Record<string, unknown>>;
    const second = content[1]?.content as Array<Record<string, unknown>>;
    expect(first[0]?.text).toBe("clicked once");
    expect(second[0]?.text).toBe("clicked twice");
  });

  it("does not claim a call that is not this toolset's", async () => {
    const foreign = { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } };
    const transport = scriptedTransport([
      message([foreign, text("Listing files.")]),
      message([text("done")]),
    ]);
    const turn = await openSession(transport.customFetch).start(startInput);

    // A request that also declared other tools produces blocks this adapter
    // must not claim. Answering one with a computer-use failure would tell the
    // model the wrong thing happened to a tool it has elsewhere. A member name
    // is not unique across toolsets, so the marker is what identifies a call as
    // ours.
    expect(turn.actions).toHaveLength(0);
    expect(turn.text).toBe("Listing files.");
  });

  it("still rejects a turn that is nothing but another toolset's calls", async () => {
    const transport = scriptedTransport([
      message([{ type: "tool_use", id: "toolu_1", name: "bash", input: {} }]),
    ]);

    // Nothing here is answerable as computer use, so the turn is not a finished
    // task. Reporting success would end the run having done nothing.
    await expect(openSession(transport.customFetch).start(startInput)).rejects.toThrow(
      /neither an action nor a message/,
    );
  });

  it("rejects a JPEG capture instead of sending it", async () => {
    const transport = scriptedTransport([message([use("left_click", { coordinate: [1, 1] })])]);
    await expect(
      openSession(transport.customFetch).start({
        ...startInput,
        screenshot: { ...CAPTURE, mimeType: "image/jpeg" },
      }),
    ).rejects.toThrow(/PNG/);
    expect(transport.customFetch).not.toHaveBeenCalled();
  });
});

describe("anthropic computer use action mapping", () => {
  const actionFor = async (name: string, input: Record<string, unknown>) => {
    const transport = scriptedTransport([message([use(name, input)])]);
    return only(await openSession(transport.customFetch).start(startInput));
  };

  it("scales a capture pixel onto the display", async () => {
    // Halfway across a 1280 wide capture is halfway across a 1920 wide display.
    expect(await actionFor("left_click", { coordinate: [640, 360] })).toEqual({
      type: "click",
      x: 960,
      y: 540,
      button: "left",
      clicks: 1,
    });
  });

  it("reads the button and count a click names", async () => {
    expect(await actionFor("right_click", { coordinate: [0, 0] })).toMatchObject({
      button: "right",
    });
    expect(await actionFor("triple_click", { coordinate: [0, 0] })).toMatchObject({
      clicks: 3,
    });
  });

  it("splits a modifier combination into separate keys", async () => {
    expect(await actionFor("left_click", { coordinate: [0, 0], text: "ctrl+shift" })).toMatchObject(
      { modifiers: ["ctrl", "shift"] },
    );
  });

  it("scales both ends of a drag", async () => {
    expect(
      await actionFor("left_click_drag", {
        start_coordinate: [0, 0],
        coordinate: [640, 360],
      }),
    ).toEqual({ type: "drag", fromX: 0, fromY: 0, toX: 960, toY: 540 });
  });

  it("scales a zoom region onto the display", async () => {
    expect(await actionFor("zoom", { region: [0, 0, 640, 360] })).toEqual({
      type: "zoom",
      region: { x0: 0, y0: 0, x1: 960, y1: 540 },
    });
  });

  it("converts wheel clicks into physical pixels", async () => {
    expect(
      await actionFor("scroll", { scroll_direction: "down", scroll_amount: 3 }),
    ).toEqual({ type: "scroll", direction: "down", amount: 360 });
  });

  it("keeps a modifier on a scroll that names no coordinate", async () => {
    // The coordinate is optional and the modifier is independent of it. A
    // model scrolling a pane it is already over names no coordinate, so
    // gating the modifier on one turns a shift-scroll into a plain scroll.
    expect(
      await actionFor("scroll", {
        scroll_direction: "down",
        scroll_amount: 2,
        text: "shift",
      }),
    ).toEqual({
      type: "scroll",
      direction: "down",
      amount: 240,
      modifiers: ["shift"],
    });
  });

  it("keeps a modifier on a scroll that does name a coordinate", async () => {
    expect(
      await actionFor("scroll", {
        scroll_direction: "down",
        scroll_amount: 2,
        coordinate: [400, 300],
        text: "shift",
      }),
    ).toEqual({
      type: "scroll",
      direction: "down",
      amount: 240,
      modifiers: ["shift"],
    });
  });

  it("keeps a key repeat the provider bounded it to", async () => {
    expect(await actionFor("key", { text: "Tab", repeat: 4 })).toEqual({
      type: "key",
      keys: ["Tab"],
      repeat: 4,
    });
  });

  it.each([100000, 0, -5, 2.5])(
    "refuses a repeat of %s rather than pressing once",
    async (repeat) => {
      // An unbounded repeat turns one model turn into an unbounded number of key
      // presses, and a zero or fractional one is not a number of presses at all.
      // Reading either as "press once" answers the request with a press the
      // model did not ask for and reports it as done, which is the outcome the
      // refusal exists to prevent.
      const action = await actionFor("key", { text: "Tab", repeat });
      expect(action.type).toBe("unsupported");
      if (action.type === "unsupported") {
        expect(action.reason).toContain("repeat");
      }
    },
  );

  it("presses once when the provider omits the repeat", async () => {
    // Absent is different from unreadable. The provider documents a default of
    // one, so an omitted repeat is a real request for a single press.
    expect(await actionFor("key", { text: "Tab" })).toEqual({
      type: "key",
      keys: ["Tab"],
    });
  });

  it("converts a held key's duration to milliseconds", async () => {
    expect(await actionFor("hold_key", { text: "Shift", duration: 2 })).toEqual({
      type: "key",
      keys: ["Shift"],
      holdMs: 2000,
    });
  });

  it("lifts a trailing newline into a press of Return", async () => {
    expect(await actionFor("type", { text: "search\n" })).toEqual({
      type: "type",
      text: "search",
      pressEnter: true,
    });
  });

  it("refuses text with a newline in the middle rather than dropping the rest", async () => {
    // Only a trailing newline is a Return request. One in the middle is text
    // the field is meant to receive, and the action cannot express that, so
    // typing the first line and reporting success would lose a line of whatever
    // the model was writing.
    const action = await actionFor("type", { text: "first\nsecond" });
    expect(action.type).toBe("unsupported");
    if (action.type === "unsupported") {
      expect(action.reason).toContain("newline");
    }
  });

  it("maps the press-only members with no arguments", async () => {
    expect(await actionFor("left_mouse_down", {})).toEqual({
      type: "mouse_down",
      button: "left",
    });
    expect(await actionFor("cursor_position", {})).toEqual({ type: "cursor_position" });
    expect(await actionFor("screenshot", {})).toEqual({ type: "screenshot" });
  });

  it.each(["left_click", "right_click", "middle_click", "double_click", "triple_click"])(
    "refuses %s with no coordinate, and names itself as the reason",
    async (name) => {
      // The provider documents an omitted coordinate as "click where the cursor
      // already is", so refusing it is this client's constraint and saying the
      // provider needs the coordinate is false. It also teaches the model to
      // invent a coordinate it does not need. Clicking the corner instead, as a
      // defaulted point would, is the outcome this refusal exists to avoid.
      const action = await actionFor(name, {});
      expect(action.type).toBe("unsupported");
      if (action.type === "unsupported") {
        expect(action.reason).toContain("this client");
      }
    },
  );

  it("still reads the button and the count of a click that names a point", async () => {
    // The refusal path must not have swallowed the branches into one shape:
    // folding five cases together is what makes a per-case mapping untestable.
    expect(await actionFor("right_click", { coordinate: [10, 20] })).toMatchObject({
      type: "click",
      button: "right",
      clicks: 1,
    });
    expect(await actionFor("triple_click", { coordinate: [10, 20] })).toMatchObject({
      type: "click",
      clicks: 3,
    });
  });

  it("refuses a member this build has never heard of", async () => {
    // Providers add members without renaming the toolset, so an unknown name is
    // an expected input rather than an impossible one.
    const action = await actionFor("teleport", { coordinate: [0, 0] });
    expect(action).toMatchObject({
      type: "unsupported",
      providerName: "teleport",
    });
  });

  it("rejects a turn that carries neither a call nor prose", async () => {
    const transport = scriptedTransport([message([])]);
    await expect(openSession(transport.customFetch).start(startInput)).rejects.toThrow(
      /neither an action nor a message/,
    );
  });
});

describe("anthropic computer use failures", () => {
  it("does not reissue a request the provider rejected", async () => {
    const customFetch: CustomFetch = vi.fn(
      async () => new Response("bad request", { status: 400 }),
    );
    await expect(openSession(customFetch).start(startInput)).rejects.toThrow(
      /Claude responded 400/,
    );
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("stops immediately when the caller aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const customFetch: CustomFetch = vi.fn(async () => new Response("busy", { status: 503 }));

    await expect(openSession(customFetch).start(startInput, controller.signal)).rejects.toThrow();
    expect(customFetch).not.toHaveBeenCalled();
  });
});