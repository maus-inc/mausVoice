import type {
  ComputerUseAction,
  ComputerUseActionRequest,
  ComputerUseAdvanceInput,
  ComputerUseMouseButton,
  ComputerUseScreenshot,
  ComputerUseScrollDirection,
  ComputerUseSession,
  ComputerUseTurn,
  ComputerUseTurnInput,
  ProviderCapabilities,
} from "@maus-inc/types";
import type { CustomFetch } from "../types";
import {
  readArguments,
  readBoundedCount,
  readNumberArray,
  readPoint,
  readSecondsAsMs,
  readString,
  type ComputerUseArguments,
  type PointSpellings,
} from "./argument-readers";
import { scaleCaptureCoordinate } from "./coordinate-scale";
import {
  assertScreenshotIsPng,
  assertTurnHasContent,
  buildComputerUseTransport,
  describeResult,
  requestComputerUseTurn,
  type ComputerUseTransport,
} from "./computer-use-transport";

/**
 * Computer use against a provider that keeps no server-side conversation.
 *
 * This provider has no session to name. The conversation is the message list,
 * it is resent in full every turn, and it grows for as long as the run does.
 * That single difference is why this adapter holds an array and the other
 * adapter holds a string, and it is the reason the loop cannot be written once
 * for both without hiding this behind an interface.
 *
 * Coordinates arrive as pixels inside the screenshot the model was shown, not
 * as pixels on the screen, so every point is measured against the capture's own
 * width before it becomes an action. A downscaled capture is the normal case,
 * and skipping this step is how a click lands on the wrong control.
 */

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const LABEL = "Claude";

/** The version header the Messages API requires. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The marker that identifies a call as one of this toolset's members.
 *
 * Dispatch reads the pair rather than the name alone, because the request may
 * also declare tools of its own and a name is not unique across them. A block
 * without this marker is not ours to answer.
 */
const COMPUTER_TOOLSET_NAME = "computer";

const TOOLSET_TYPE = "computer_toolset_20260801";

/** Upper bound on one response. Comfortably above a screen's worth of actions. */
const MAX_TOKENS = 4096;

const MAX_KEY_REPEAT = 100;

/** Documented ceilings on a held key and on a pause. */
const MAX_HOLD_SECONDS = 300;
const MAX_WAIT_SECONDS = 300;

type AnthropicBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
};

type AnthropicMessage = {
  role: "assistant" | "user";
  content: unknown[];
};

const imageBlock = (screenshot: ComputerUseScreenshot) => ({
  type: "image",
  source: {
    type: "base64",
    media_type: screenshot.mimeType,
    data: screenshot.data,
  },
});

const unsupported = (
  providerName: string,
  reason: string,
): ComputerUseAction => ({ type: "unsupported", providerName, reason });

const MODIFIER_SEPARATOR = "+";

/** This provider writes a point as an `[x, y]` pair. */
const POINT: PointSpellings = { xKey: "x", yKey: "y", tupleKeys: ["coordinate"] };

/** A drag's first point, spelled differently from where it ends. */
const DRAG_START_POINT: PointSpellings = {
  xKey: "x",
  yKey: "y",
  tupleKeys: ["start_coordinate"],
};

/**
 * The modifiers held for one action.
 *
 * They arrive as a single string that may itself be a combination, so it is
 * split rather than taken whole, because the executor holds keys individually.
 */
const readModifiers = (args: ComputerUseArguments): string[] | undefined => {
  const text = readString(args, "text");
  if (text === undefined) {
    return undefined;
  }
  const keys = text
    .split(MODIFIER_SEPARATOR)
    .map((key) => key.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : undefined;
};

/**
 * A point in the capture's own pixels, as a physical pixel.
 *
 * Every coordinate the provider sends is in this space, including the region a
 * zoom asks for and the position a cursor report means, so the conversion is
 * made in one place rather than at each call site.
 */
const toDisplay = (
  value: number,
  captureExtent: number,
  displayExtent: number,
): number => scaleCaptureCoordinate(value, captureExtent, displayExtent);

const mapToolUse = (
  name: string,
  args: ComputerUseArguments,
  captureWidth: number,
  captureHeight: number,
  displayWidth: number,
  displayHeight: number,
): ComputerUseAction => {
  const point = () => {
    const raw = readPoint(args, POINT);
    if (!raw) {
      return undefined;
    }
    return {
      x: toDisplay(raw.x, captureWidth, displayWidth),
      y: toDisplay(raw.y, captureHeight, displayHeight),
    };
  };
  const clickAt = (button: ComputerUseMouseButton) => {
    const found = point();
    if (!found) {
      return undefined;
    }
    const modifiers = readModifiers(args);
    return {
      ...found,
      button,
      ...(modifiers ? { modifiers } : {}),
    };
  };

  switch (name) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const button =
        name === "right_click"
          ? "right"
          : name === "middle_click"
            ? "middle"
            : "left";
      const clicks = name === "double_click" ? 2 : name === "triple_click" ? 3 : 1;
      const found = clickAt(button);
      if (!found) {
        // The provider itself treats an omitted coordinate as "click where the
        // cursor already is", so blaming it here would be false and would push
        // the model into inventing a coordinate it does not need. The reason
        // is ours: the portable action names a point, so a click without one is
        // refused and the model is told who requires it.
        return unsupported(
          name,
          "this client needs a coordinate for a click. Move the cursor first, then click with a coordinate.",
        );
      }
      return { type: "click", clicks, ...found };
    }
    case "left_click_drag": {
      const start = readPoint(args, DRAG_START_POINT);
      const end = readPoint(args, POINT);
      if (!start || !end) {
        return unsupported(name, "left_click_drag needs a start and an end coordinate");
      }
      const modifiers = readModifiers(args);
      return {
        type: "drag",
        fromX: toDisplay(start.x, captureWidth, displayWidth),
        fromY: toDisplay(start.y, captureHeight, displayHeight),
        toX: toDisplay(end.x, captureWidth, displayWidth),
        toY: toDisplay(end.y, captureHeight, displayHeight),
        ...(modifiers ? { modifiers } : {}),
      };
    }
    case "mouse_move": {
      const found = point();
      return found
        ? { type: "move", ...found }
        : unsupported(name, "mouse_move needs a coordinate");
    }
    case "left_mouse_down":
      return { type: "mouse_down", button: "left" };
    case "left_mouse_up":
      return { type: "mouse_up", button: "left" };
    case "cursor_position":
      return { type: "cursor_position" };
    case "screenshot":
      return { type: "screenshot" };
    case "zoom": {
      const region = readNumberArray(args, "region");
      if (!region || region.length !== 4) {
        return unsupported(name, "zoom needs a region of four coordinates");
      }
      return {
        type: "zoom",
        region: {
          x0: toDisplay(region[0], captureWidth, displayWidth),
          y0: toDisplay(region[1], captureHeight, displayHeight),
          x1: toDisplay(region[2], captureWidth, displayWidth),
          y1: toDisplay(region[3], captureHeight, displayHeight),
        },
      };
    }
    case "scroll": {
      const direction = readString(args, "scroll_direction");
      const amount = readBoundedCount(args, "scroll_amount", 0, Number.MAX_SAFE_INTEGER);
      if (
        (direction !== "up" &&
          direction !== "down" &&
          direction !== "left" &&
          direction !== "right") ||
        amount === undefined
      ) {
        return unsupported(name, "scroll needs a direction and an amount");
      }
      const modifiers = readModifiers(args);
      return {
        type: "scroll",
        direction: direction as ComputerUseScrollDirection,
        // The provider counts wheel clicks. The portable vocabulary counts
        // pixels, so the conversion happens here rather than leaving the
        // executor to guess how far a click scrolls on a given system.
        amount: amount * PIXELS_PER_WHEEL_CLICK,
        // The coordinate is deliberately dropped: the executor scrolls under
        // the pointer, and a model scrolling repeatedly names no coordinate
        // because the pointer is already where it wants to be. The modifier is
        // independent of it, so gating one on the other silently downgraded a
        // shift-scroll or a cmd-scroll into a plain scroll.
        ...(modifiers ? { modifiers } : {}),
      };
    }
    case "type": {
      const text = readString(args, "text");
      // The provider's text parameter doubles as the key to press, and a
      // newline in it is a request to press Return. A model that cannot send a
      // newline is one that cannot finish typing into a single-line field, so
      // the newline is lifted out rather than discarded.
      if (text === undefined) {
        return unsupported(name, "type needs text");
      }
      // Only a TRAILING newline is a Return request, and that is the one this
      // lifts out. A newline in the middle is text the field is meant to
      // receive, and the vocabulary cannot express "type text that contains a
      // newline", so passing it along would type the first line and report
      // success. Refusing it tells the model what actually happened.
      const endsWithNewline = text.endsWith("\n");
      const body = endsWithNewline ? text.slice(0, -1) : text;
      if (body.includes("\n")) {
        return unsupported(name, "type cannot contain a newline except one at the end");
      }
      return endsWithNewline
        ? { type: "type", text: body, pressEnter: true }
        : { type: "type", text: body };
    }
    case "key": {
      const text = readString(args, "text");
      if (text === undefined) {
        return unsupported(name, "key needs a key");
      }
      // The provider documents 1 to 100 and nothing else, so a repeat it did send
      // and this refused is refused. Reading the same unreadable value as
      // "press once" answers a request for a hundred presses, or for none, with
      // a single press and reports success.
      if (args["repeat"] !== undefined) {
        const repeat = readBoundedCount(args, "repeat", 1, MAX_KEY_REPEAT);
        return repeat === undefined
          ? unsupported(name, `key repeat must be a whole number from 1 to ${MAX_KEY_REPEAT}`)
          : { type: "key", keys: [text], repeat };
      }
      return { type: "key", keys: [text] };
    }
    case "hold_key": {
      const text = readString(args, "text");
      const holdMs = readSecondsAsMs(args, "duration", MAX_HOLD_SECONDS);
      if (text === undefined || holdMs === undefined) {
        return unsupported(name, "hold_key needs a key and a duration");
      }
      return { type: "key", keys: [text], holdMs };
    }
    case "wait": {
      const ms = readSecondsAsMs(args, "duration", MAX_WAIT_SECONDS);
      return ms === undefined
        ? unsupported(name, "wait needs a duration")
        : { type: "wait", ms };
    }
    default:
      return unsupported(name, `Unsupported computer-use action ${name}`);
  }
};

/**
 * How far one wheel click scrolls, in physical pixels.
 *
 * The provider counts wheel clicks because that is a portable unit across
 * operating systems, and it is not a distance. Every desktop here treats a
 * click as the same physical distance, so the conversion has one honest value
 * rather than a per-platform guess.
 */
const PIXELS_PER_WHEEL_CLICK = 120;

type ReadTurn = {
  actions: ComputerUseActionRequest[];
  text: string;
  /** The assistant turn verbatim, so the next request can quote it back. */
  reply: AnthropicMessage;
};

const readBlocks = (payload: unknown): AnthropicBlock[] => {
  const content = (payload as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? (content as AnthropicBlock[]) : [];
};

/**
 * Read one response into the portable shape, keeping the blocks we quoted.
 *
 * The raw blocks are retained because the provider requires the assistant turn
 * to be sent back exactly as it arrived. Reconstructing it from the portable
 * actions would lose anything the provider sent that the vocabulary has no name
 * for, and the next request would then be rejected.
 */
const readResponse = (
  payload: unknown,
  captureWidth: number,
  captureHeight: number,
  displayWidth: number,
  displayHeight: number,
): ReadTurn => {
  const actions: ComputerUseActionRequest[] = [];
  const texts: string[] = [];
  const reply: AnthropicBlock[] = [];

  for (const block of readBlocks(payload)) {
    if (block.type === "text" && block.text) {
      texts.push(block.text);
    }
    if (block.type !== "tool_use") {
      continue;
    }
    // Only this toolset's members are ours to answer. A request that also
    // declared other tools can produce a block we must not claim, and answering
    // it with a computer-use failure would tell the model the wrong thing
    // happened to a tool it has elsewhere.
    if (
      typeof block.name !== "string" ||
      typeof block.id !== "string" ||
      block.name === COMPUTER_TOOLSET_NAME ||
      !("toolset_name" in block)
    ) {
      continue;
    }
    actions.push({
      callId: block.id,
      providerName: block.name,
      action: mapToolUse(
        block.name,
        readArguments(block.input),
        captureWidth,
        captureHeight,
        displayWidth,
        displayHeight,
      ),
    });
    reply.push(block);
  }

  return {
    actions,
    text: texts.join("").trim(),
    reply: { role: "assistant", content: reply },
  };
};

/**
 * One result block.
 *
 * The marker is echoed because the provider rejects a result that omits it or
 * names a different toolset. The image is attached to the last result of a
 * batch when the batch did not end by asking for a screenshot, which saves a
 * round trip and is what the provider documents as the cheaper option.
 */
const resultBlock = (
  result: ComputerUseAdvanceInput["results"][number],
  content: unknown[],
  isError: boolean,
) => ({
  type: "tool_result",
  tool_use_id: result.callId,
  toolset_name: COMPUTER_TOOLSET_NAME,
  ...(isError ? { is_error: true } : {}),
  content,
});

/**
 * The text a later action gets when an earlier one failed.
 *
 * The provider reads this exact sentence to know the action was skipped rather
 * than attempted, and it replans differently for the two. Rephrasing it makes
 * the model retry the action it should have abandoned.
 */
export const NOT_EXECUTED_AFTER_FAILURE =
  "Not executed: an earlier computer action in this turn failed.";

export type AnthropicComputerUseConfig = {
  apiKey: string;
  model: string;
  /** Members this client cannot perform, withheld from the toolset. */
  disabledMembers?: readonly string[];
  customFetch?: CustomFetch;
  /** Called with each coordinate conversion, so a bad click can be traced. */
  onCoordinateTransform?: (detail: string) => void;
};

export const createAnthropicComputerUseSession = (
  config: AnthropicComputerUseConfig,
): ComputerUseSession => {
  const transport: ComputerUseTransport = buildComputerUseTransport(
    config.customFetch ?? fetch,
  );
  const messages: AnthropicMessage[] = [];

  const toolEntry = () => ({
    type: TOOLSET_TYPE,
    ...(config.disabledMembers && config.disabledMembers.length > 0
      ? {
          configs: Object.fromEntries(
            config.disabledMembers.map((member) => [member, { enabled: false }]),
          ),
        }
      : {}),
  });

  /**
   * The system prompt, held rather than passed per turn.
   *
   * It is fixed for the whole run, and a request that resent it would pay for
   * the same several hundred tokens on every turn of a conversation that can
   * reach thirty of them.
   */
  let system = "";

  const turn = async (
    extents: {
      capture: { width: number; height: number };
      displayWidth: number;
      displayHeight: number;
    },
    signal?: AbortSignal,
  ): Promise<ComputerUseTurn> => {
    config.onCoordinateTransform?.(
      `Claude computer use scaling ${extents.capture.width}x${extents.capture.height} capture onto ${extents.displayWidth}x${extents.displayHeight} display`,
    );
    const payload = await requestComputerUseTurn({
      transport,
      url: ANTHROPIC_MESSAGES_URL,
      headers: {
        "x-api-key": config.apiKey.trim(),
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: {
        model: config.model,
        max_tokens: MAX_TOKENS,
        system,
        tools: [toolEntry()],
        messages,
      },
      label: LABEL,
      signal,
    });
    const read = readResponse(
      payload,
      extents.capture.width,
      extents.capture.height,
      extents.displayWidth,
      extents.displayHeight,
    );
    messages.push(read.reply);
    const mapped: ComputerUseTurn = { actions: read.actions, text: read.text };
    assertTurnHasContent(mapped);
    return mapped;
  };

  return {
    async start(
      input: ComputerUseTurnInput,
      signal?: AbortSignal,
    ): Promise<ComputerUseTurn> {
      assertScreenshotIsPng(input.screenshot);
      messages.length = 0;
      system = input.systemPrompt;
      // The instruction names the target before the pixels, which measurably
      // improves where the model clicks.
      messages.push({
        role: "user",
        content: [
          { type: "text", text: input.goal },
          imageBlock(input.screenshot),
        ],
      });
      return turn(
        {
          capture: { width: input.screenshot.width, height: input.screenshot.height },
          displayWidth: input.displayWidth,
          displayHeight: input.displayHeight,
        },
        signal,
      );
    },

    async advance(
      input: ComputerUseAdvanceInput,
      signal?: AbortSignal,
    ): Promise<ComputerUseTurn> {
      assertScreenshotIsPng(input.screenshot);

      const lastIndex = input.results.length - 1;
      // The provider runs a batch in order and halts at the first failure, so
      // every result after that one has to say it was never attempted. Deriving
      // that here rather than trusting each call site to notice means a caller
      // that kept executing a dependent action after a failure cannot produce a
      // turn that claims the whole batch ran.
      const firstFailure = input.results.findIndex((result) => !result.success);
      let imageAttached = false;
      const blocks = input.results.map((result, index) => {
        const afterFailure = firstFailure !== -1 && index > firstFailure;
        const content: unknown[] = [
          {
            type: "text",
            text: afterFailure ? NOT_EXECUTED_AFTER_FAILURE : describeResult(result),
          },
        ];
        if (afterFailure) {
          return resultBlock(result, content, true);
        }
        // A member that exists to show the screen is answered with the screen,
        // and the last block gets it too when nothing in the batch asked. That
        // keeps the model from spending a turn on a screenshot it would have
        // been given.
        if (!result.success) {
          imageAttached = imageAttached || index === lastIndex;
          return resultBlock(result, content, true);
        }
        if (!imageAttached && (INDEX_MEMBERS_WANTING_IMAGE.has(result.providerName) || index === lastIndex)) {
          content.push(imageBlock(input.screenshot));
          imageAttached = true;
        }
        return resultBlock(result, content, false);
      });
      messages.push({ role: "user", content: blocks });
      return turn(
        {
          capture: { width: input.screenshot.width, height: input.screenshot.height },
          displayWidth: input.displayWidth,
          displayHeight: input.displayHeight,
        },
        signal,
      );
    },
  };
};

/** Members whose whole purpose is to return the screen. */
const INDEX_MEMBERS_WANTING_IMAGE = new Set(["screenshot", "zoom"]);

export const ANTHROPIC_COMPUTER_USE_CAPABILITIES: ProviderCapabilities = {
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsVision: true,
  supportsComputerUse: true,
  supportsStructuredOutput: true,
  supportsThinking: true,
  computerUseEnvironment: "desktop",
};