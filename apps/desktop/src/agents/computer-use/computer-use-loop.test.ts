import type {
  CaptureRequest,
  CapturedFrame,
  DisplayGeometry,
  PhysicalRect,
} from "@maus-inc/desktop-native-apis";
import type {
  ComputerUseAction,
  ComputerUseActionResult,
  ComputerUseTurn,
} from "@maus-inc/types";
import { describe, expect, it, vi } from "vitest";
import type { ComputerUseHost } from "./computer-use-executor";
import {
  ComputerUseLoop,
  StuckDetector,
  type ComputerUseApprovalAnswer,
  type ComputerUseApprovalRequest,
} from "./computer-use-loop";

const DISPLAY: DisplayGeometry = {
  id: 1,
  originX: 0,
  originY: 0,
  widthPx: 1920,
  heightPx: 1080,
  scaleFactor: 1,
};

/** A frame whose bytes change when `marker` changes, so digests differ. */
const frame = (
  marker: string,
  over: Partial<CapturedFrame> = {},
): CapturedFrame => ({
  data: marker,
  mimeType: "image/png",
  imageWidth: 1280,
  imageHeight: 720,
  sourceWidth: 1920,
  sourceHeight: 1080,
  displayId: 1,
  ...over,
});

const request = (callId: string, action: ComputerUseAction) => ({
  callId,
  providerName: "scripted",
  action,
});

/** A host with no recording, for tests that only care what did NOT happen. */
const hostThatRecords = (): ComputerUseHost => ({
  listDisplays: vi.fn(async () => [DISPLAY]),
  captureScreen: vi.fn(async () => frame("a")),
  captureScreenRegion: vi.fn(async () => frame("a")),
  computerUsePointerPosition: vi.fn(async (): Promise<[number, number]> => [
    0, 0,
  ]),
  computerUseMove: vi.fn(async () => undefined),
  computerUseClick: vi.fn(async () => undefined),
  computerUsePressButton: vi.fn(async () => undefined),
  computerUseReleaseButton: vi.fn(async () => undefined),
  computerUseDrag: vi.fn(async () => undefined),
  computerUseScroll: vi.fn(async () => undefined),
  computerUsePressKey: vi.fn(async () => undefined),
  computerUsePressKeyDown: vi.fn(async () => undefined),
  computerUseReleaseKeyUp: vi.fn(async () => undefined),
  computerUseType: vi.fn(async () => undefined),
  computerUseWait: vi.fn(async () => undefined),
  computerUseCancel: vi.fn(async () => undefined),
  computerUseResetCancel: vi.fn(async () => undefined),
});

type Harness = {
  loop: ComputerUseLoop;
  host: ComputerUseHost;
  asked: ComputerUseApprovalRequest[];
  screens: string[];
  captureScreen: ReturnType<typeof vi.fn>;
};

const harness = (
  turns: ComputerUseTurn[],
  overrides: {
    answers?: ComputerUseApprovalAnswer[];
    maxTurns?: number;
    markers?: string[];
  } = {},
): Harness => {
  const asked: ComputerUseApprovalRequest[] = [];
  const screens: string[] = [];
  const markers = overrides.markers ?? ["a", "b", "c", "d", "e", "f", "g", "h"];
  let captureIndex = 0;
  const captureScreen = vi.fn(async (_request: CaptureRequest) => {
    const marker = markers[Math.min(captureIndex, markers.length - 1)];
    captureIndex += 1;
    screens.push(marker);
    return frame(marker);
  });

  const answers = [...(overrides.answers ?? [])];
  const host: ComputerUseHost = {
    listDisplays: vi.fn(async () => [DISPLAY]),
    captureScreen,
    captureScreenRegion: vi.fn(async (_p: CapturedFrame, _r: PhysicalRect) =>
      frame("z"),
    ),
    computerUsePointerPosition: vi.fn(async (): Promise<[number, number]> => [
      1, 2,
    ]),
    computerUseMove: vi.fn(async () => undefined),
    computerUseClick: vi.fn(async () => undefined),
    computerUsePressButton: vi.fn(async () => undefined),
    computerUseReleaseButton: vi.fn(async () => undefined),
    computerUseDrag: vi.fn(async () => undefined),
    computerUseScroll: vi.fn(async () => undefined),
    computerUsePressKey: vi.fn(async () => undefined),
    computerUsePressKeyDown: vi.fn(async () => undefined),
    computerUseReleaseKeyUp: vi.fn(async () => undefined),
    computerUseType: vi.fn(async () => undefined),
    computerUseWait: vi.fn(async () => undefined),
    computerUseCancel: vi.fn(async () => undefined),
    computerUseResetCancel: vi.fn(async () => undefined),
  };

  let turnIndex = 0;
  const loop = new ComputerUseLoop({
    session: {
      start: async () => {
        const turn = turns[Math.min(turnIndex, turns.length - 1)];
        turnIndex += 1;
        return turn;
      },
      advance: async () => {
        const turn = turns[Math.min(turnIndex, turns.length - 1)];
        turnIndex += 1;
        return turn;
      },
    },
    host,
    goal: "open the settings window",
    systemPrompt: "you drive a computer",
    maxTurns: overrides.maxTurns ?? 8,
    stuckTurnsBeforeGivingUp: 2,
    requestApproval: async (req) => {
      asked.push(req);
      return { answer: answers.shift() ?? "approve" };
    },
  });

  return { loop, host, asked, screens, captureScreen };
};

const collect = async (loop: ComputerUseLoop, signal?: AbortSignal) => {
  const events = [];
  for await (const event of loop.run(signal)) {
    events.push(event);
  }
  return events;
};

describe("ComputerUseLoop", () => {
  it("acts on each turn and finishes when the model stops asking for actions", async () => {
    const { loop, host } = harness([
      { actions: [request("a", { type: "click", x: 100, y: 100 })], text: "" },
      { actions: [request("b", { type: "type", text: "hi" })], text: "" },
      { actions: [], text: "All done." },
    ]);

    const events = await collect(loop);

    expect(host.computerUseClick).toHaveBeenCalledTimes(1);
    expect(host.computerUseType).toHaveBeenCalledWith("hi", false);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "done" });
    expect(events.filter((e) => e.type === "text")).toHaveLength(1);
  });

  it("answers every call the model made, even when one was refused", async () => {
    const { loop } = harness(
      [
        {
          actions: [
            request("a", { type: "click", x: 10, y: 10 }),
            request("b", { type: "click", x: 20, y: 20 }),
          ],
          text: "",
        },
        { actions: [], text: "done" },
      ],
      { answers: ["deny", "approve"] },
    );

    const results: ComputerUseActionResult[] = [];
    for await (const event of loop.run()) {
      if (event.type === "action-result") {
        results.push(event.result);
      }
    }

    expect(results).toHaveLength(2);
    expect(results[0].skipped).toBe(true);
    expect(results[1].success).toBe(true);
  });

  it("gives a refused action back to the model as a refusal, not an error", async () => {
    const { loop } = harness(
      [
        { actions: [request("a", { type: "click", x: 1, y: 1 })], text: "" },
        { actions: [], text: "ok" },
      ],
      { answers: ["deny"] },
    );

    const results: ComputerUseActionResult[] = [];
    for await (const event of loop.run()) {
      if (event.type === "action-result") results.push(event.result);
    }
    expect(results[0].success).toBe(false);
    expect(results[0].skipped).toBe(true);
  });

  it("asks about a click but not about looking at the screen", async () => {
    const { loop, asked } = harness([
      {
        actions: [
          request("a", { type: "cursor_position" }),
          request("b", { type: "wait", ms: 10 }),
          request("c", { type: "click", x: 4, y: 4 }),
        ],
        text: "",
      },
      { actions: [], text: "done" },
    ]);

    await collect(loop);
    expect(asked).toHaveLength(1);
    expect(asked[0].summary).toMatch(/click/i);
  });

  it("stops asking after the user chooses to always allow that action", async () => {
    const { loop, asked } = harness(
      [
        { actions: [request("a", { type: "click", x: 8, y: 8 })], text: "" },
        { actions: [request("b", { type: "click", x: 8, y: 8 })], text: "" },
        { actions: [], text: "done" },
      ],
      { answers: ["always", "approve"] },
    );

    await collect(loop);
    expect(asked).toHaveLength(1);
  });

  it("captures once per turn so the model never sees a half-applied batch", async () => {
    const { loop, host, captureScreen } = harness([
      {
        actions: [
          request("a", { type: "click", x: 1, y: 1 }),
          request("b", { type: "click", x: 2, y: 2 }),
        ],
        text: "",
      },
      { actions: [], text: "done" },
    ]);

    await collect(loop);
    expect(host.computerUseClick).toHaveBeenCalledTimes(2);
    expect(captureScreen).toHaveBeenCalledTimes(2);
  });

  it("always asks the native side for PNG, because a JPEG opener is rejected", async () => {
    const { loop, captureScreen } = harness([{ actions: [], text: "done" }]);
    await collect(loop);
    expect(captureScreen).toHaveBeenCalledTimes(1);
    expect(captureScreen.mock.calls[0][0].format).toBe("png");
  });

  it("resizes the screenshot to a width the model can read", async () => {
    const { loop, captureScreen } = harness([{ actions: [], text: "done" }]);
    await collect(loop);
    expect(captureScreen.mock.calls[0][0].maxWidth).toBe(1280);
  });

  it("stops at the turn limit rather than running forever", async () => {
    const { loop } = harness(
      [{ actions: [request("a", { type: "wait", ms: 1 })], text: "" }],
      {
        maxTurns: 3,
        markers: ["same"],
      },
    );

    const events = await collect(loop);
    const finish = events.at(-1);
    expect(["max-turns", "stuck"]).toContain(
      (finish as { reason: string }).reason,
    );
  });

  it("finishes with a readable message when the run is stopped", async () => {
    const controller = new AbortController();
    const { loop } = harness([
      { actions: [request("a", { type: "click", x: 1, y: 1 })], text: "" },
      { actions: [], text: "done" },
    ]);
    controller.abort();

    const events = await collect(loop, controller.signal);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "aborted" });
  });

  it("tells the native side to stop as soon as the user stops the loop", async () => {
    const { loop, host } = harness([
      { actions: [request("a", { type: "wait", ms: 1000 })], text: "" },
      { actions: [], text: "done" },
    ]);
    const controller = new AbortController();
    const runPromise = collect(loop, controller.signal);
    loop.abort();
    controller.abort();
    await runPromise;
    expect(host.computerUseCancel).toHaveBeenCalled();
  });

  it("refuses to run twice at once", async () => {
    const { loop } = harness([{ actions: [], text: "done" }]);
    const first = collect(loop);
    await expect(collect(loop)).rejects.toThrow(/already in progress/);
    await first;
  });

  it("reports a failure with a readable message instead of throwing", async () => {
    const { loop, host } = harness([{ actions: [], text: "done" }]);
    host.listDisplays = vi.fn(async () => []);
    const events = await collect(loop);
    expect(events.at(-1)).toEqual({
      type: "finish",
      reason: "error",
      message: expect.stringMatching(/no display/i),
    });
  });

  it("leaves nothing for the provider to trip over when a stop lands mid-batch", async () => {
    const seenResults: ComputerUseActionResult[][] = [];
    const controller = new AbortController();
    let turn = 0;

    // The stop is raised from inside the first click, so it lands between two
    // actions deterministically rather than racing a timer.
    const host = hostThatRecords();
    host.computerUseClick = vi.fn(async () => {
      controller.abort();
    });

    const loop = new ComputerUseLoop({
      session: {
        start: async () => {
          turn += 1;
          return turn === 1
            ? {
                // Far apart on purpose. The stuck detector rounds coordinates
                // to a 16px grid, so three clicks a pixel apart read as one
                // action repeated three times and the run stops before any of
                // them runs. That is the detector working, not a failure here.
                actions: [
                  request("a", { type: "click", x: 10, y: 10 }),
                  request("b", { type: "click", x: 200, y: 10 }),
                  request("c", { type: "click", x: 400, y: 10 }),
                ],
                text: "",
              }
            : { actions: [], text: "done" };
        },
        advance: async (input) => {
          seenResults.push([...input.results]);
          return { actions: [], text: "done" };
        },
      },
      host,
      goal: "g",
      systemPrompt: "s",
      maxTurns: 4,
      stuckTurnsBeforeGivingUp: 2,
      requestApproval: async () => ({ answer: "approve" }),
    });

    await collect(loop, controller.signal);

    // One click went out before the stop, and the run ends there. No second
    // request is made, so the two calls that never ran are never sent back
    // unanswered, which is the only way that invariant can actually break.
    expect(host.computerUseClick).toHaveBeenCalledTimes(1);
    expect(seenResults).toHaveLength(0);
  });

  it("stops a batch mid-way when abort is called, with no signal involved", async () => {
    // The test above drives the stop through an AbortSignal, which the router
    // never supplies. This one drives it the way the Stop button does.
    //
    // The actions are ZOOMS on purpose. A click needs approval, and a second
    // click after an abort is denied by `answerApproval` before it reaches the
    // executor, so a click batch would pass with the mid-batch guards removed
    // and would prove nothing about them. A zoom needs no approval, so the
    // guards inside the action loop are the only thing that can stop it.
    const seenResults: ComputerUseActionResult[][] = [];
    const host = hostThatRecords();
    // Declared first so the zoom below can reach it. The abort lands AFTER the
    // first zoom, because that is the only point where the batch is genuinely
    // part-done.
    let loop: ComputerUseLoop;
    host.captureScreenRegion = vi.fn(async () => {
      loop.abort();
      return frame("b");
    });

    loop = new ComputerUseLoop({
      session: {
        start: async () => ({
          actions: [
            request("a", {
              type: "zoom",
              region: { x0: 0, y0: 0, x1: 10, y1: 10 },
            }),
            request("b", {
              type: "zoom",
              region: { x0: 20, y0: 20, x1: 30, y1: 30 },
            }),
            request("c", {
              type: "zoom",
              region: { x0: 40, y0: 40, x1: 50, y1: 50 },
            }),
          ],
          text: "",
        }),
        advance: async (input) => {
          seenResults.push([...input.results]);
          return { actions: [], text: "done" };
        },
      },
      host,
      goal: "g",
      systemPrompt: "s",
      maxTurns: 4,
      stuckTurnsBeforeGivingUp: 2,
      requestApproval: async () => ({ answer: "approve" }),
    });

    const events = await collect(loop);

    expect(host.captureScreenRegion).toHaveBeenCalledTimes(1);
    // Nothing is sent back at all, because a partial results array is the one
    // thing the provider rejects outright.
    expect(seenResults).toHaveLength(0);
    const finish = events.find((event) => event.type === "finish");
    expect(finish).toMatchObject({ reason: "aborted" });
  });

  it("refuses to ask about a new action once it has been stopped", async () => {
    // The guard that turns a stop into a refusal rather than a fresh prompt.
    // Without it the user presses Stop, a prompt appears a moment later, and
    // the answer they give there is consent the run was never meant to act on.
    const { loop, host, asked } = harness([
      {
        actions: [
          request("a", { type: "click", x: 10, y: 20 }),
          request("b", { type: "click", x: 30, y: 40 }),
        ],
        text: "",
      },
      { actions: [], text: "done" },
    ]);
    host.computerUseClick = vi.fn(async () => {
      loop.abort();
      return undefined;
    });

    const events = await collect(loop);

    // The first click asked and ran. The second was never put to the user.
    expect(host.computerUseClick).toHaveBeenCalledTimes(1);
    expect(asked).toHaveLength(1);
    const finish = events.find((event) => event.type === "finish");
    expect(finish).toMatchObject({ reason: "aborted" });
  });

  it("stops on its own when the model repeats itself and there is no turn limit to hit", async () => {
    // Every turn clicks the same spot and the screen never changes. The only
    // signal available here is the stuck detector, so a green run with it
    // disabled would be a silent "the loop has no idea what to do".
    const { loop } = harness(
      [{ actions: [request("a", { type: "click", x: 40, y: 40 })], text: "" }],
      { maxTurns: 30, markers: ["same"] },
    );

    const events = await collect(loop);
    const finish = events.at(-1) as { reason: string; message?: string };
    expect(finish.reason).toBe("stuck");
    expect(finish.message).toMatch(/repeating the same action/);
  });

  it("clears the native cancel flag when the run ends, so the next run is not poisoned", async () => {
    const { loop, host } = harness([{ actions: [], text: "done" }]);
    await collect(loop);
    expect(host.computerUseResetCancel).toHaveBeenCalled();
  });
});

describe("StuckDetector", () => {
  const turnOf = (actions: ComputerUseAction[]): ComputerUseTurn => ({
    actions: actions.map((action, i) => request(String(i), action)),
    text: "",
  });

  it("stops an agent that repeats one action turn after turn", () => {
    const detector = new StuckDetector(3);
    const turn = turnOf([{ type: "click", x: 100, y: 100 }]);
    expect(detector.observeTurn(turn, "a")).toBe(false);
    expect(detector.observeTurn(turn, "b")).toBe(false);
    expect(detector.observeTurn(turn, "c")).toBe(false);
    expect(detector.observeTurn(turn, "d")).toBe(true);
  });

  it("treats a click a few pixels off as the same click", () => {
    const detector = new StuckDetector(3);
    // A model retrying one button drifts by a pixel or two every time. Coarse
    // coordinates are what stop that reading as new work each turn.
    const xs = [96, 99, 101, 103];
    const stuck = xs.map((x, i) =>
      detector.observeTurn(
        turnOf([{ type: "click", x, y: 100 }]),
        `screen-${i}`,
      ),
    );
    expect(stuck).toEqual([false, false, false, true]);
  });

  it("does not fire on an agent that is making progress", () => {
    const detector = new StuckDetector(3);
    expect(
      detector.observeTurn(turnOf([{ type: "click", x: 1, y: 1 }]), "a"),
    ).toBe(false);
    expect(
      detector.observeTurn(turnOf([{ type: "click", x: 500, y: 1 }]), "b"),
    ).toBe(false);
    expect(
      detector.observeTurn(turnOf([{ type: "type", text: "x" }]), "c"),
    ).toBe(false);
    expect(detector.isStuck()).toBe(false);
  });

  it("stops an agent whose turns achieve nothing", () => {
    const detector = new StuckDetector(9);
    const turn = turnOf([{ type: "wait", ms: 100 }]);
    expect(detector.observeTurn(turn, "a")).toBe(false);
    expect(detector.observeTurn(turn, "b")).toBe(false);
    expect(detector.observeTurn(turn, "c")).toBe(true);
  });

  it("stops an agent whose screen never changes", () => {
    const detector = new StuckDetector(9);
    // Each turn types something different, so the repeated-action and
    // unproductive-turn signals both stay quiet and only the screen can fire.
    const types = ["one", "two", "three", "four", "five", "six"];
    const seen = types.map((text, i) =>
      detector.observeTurn(
        turnOf([{ type: "type", text }]),
        i === 0 ? "first" : "same",
      ),
    );
    // The first turn records the screen rather than comparing against it, so
    // the fourth repeat is the turn that fires.
    expect(seen).toEqual([false, false, false, false, false, true]);
  });

  it("says what it noticed, in words the user can act on", () => {
    const detector = new StuckDetector(2);
    const turn = turnOf([{ type: "click", x: 5, y: 5 }]);
    detector.observeTurn(turn, "a");
    detector.observeTurn(turn, "b");
    detector.observeTurn(turn, "c");
    expect(detector.reason()).toMatch(/repeating the same action/);
  });
});

describe("ComputerUseLoop without a way to ask", () => {
  it("denies rather than approves, because silence is not consent", async () => {
    const host = hostThatRecords();
    const loop = new ComputerUseLoop({
      session: {
        start: async () => ({
          actions: [request("a", { type: "click", x: 1, y: 1 })],
          text: "",
        }),
        advance: async () => ({ actions: [], text: "done" }),
      },
      host,
      goal: "g",
      systemPrompt: "s",
      maxTurns: 3,
      stuckTurnsBeforeGivingUp: 2,
    });

    const results: ComputerUseActionResult[] = [];
    for await (const event of loop.run()) {
      if (event.type === "action-result") results.push(event.result);
    }
    expect(host.computerUseClick).not.toHaveBeenCalled();
    expect(results[0].skipped).toBe(true);
  });
});
