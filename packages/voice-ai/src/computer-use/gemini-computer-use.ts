import type {
  ComputerUseAction,
  ComputerUseActionRequest,
  ComputerUseAdvanceInput,
  ComputerUseEnvironment,
  ComputerUseScreenshot,
  ComputerUseSafetyDecision,
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
  readBoolean,
  readNumber,
  readOptionalBoundedNumber,
  readPoint,
  readSecondsAsMs,
  readString,
  readStringArray,
  type ComputerUseArguments,
  type PointSpellings,
} from "./argument-readers";
import { denormalizeGridCoordinate } from "./coordinate-scale";
import {
  assertScreenshotIsPng,
  assertTurnHasContent,
  buildComputerUseTransport,
  describeResult,
  requestComputerUseTurn,
  type ComputerUseTransport,
} from "./computer-use-transport";

/**
 * Computer use against a provider that continues a named interaction.
 *
 * The conversation lives on the provider's side. Each turn names the
 * interaction it continues and hands back one result per call it made, so this
 * adapter holds an identifier and nothing else: there is no message list to
 * grow, and no history to resend.
 *
 * Two properties of that protocol shape the rest of this file. Coordinates
 * arrive on a fixed grid and never mention the screen, so they are resolved
 * against the display before they become an action. And the provider attaches a
 * safety verdict to a call and will not accept the result without an
 * acknowledgement, so that verdict travels with the action rather than being
 * resolved here, where no user is present to ask.
 */

const GEMINI_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

const LABEL = "Gemini";

type GeminiFunctionCallStep = {
  type: "function_call";
  id?: string;
  name?: string;
  arguments?: unknown;
};

type GeminiModelOutputStep = {
  type: "model_output";
  content?: Array<{ type?: string; text?: string }>;
};

type GeminiStep = GeminiFunctionCallStep | GeminiModelOutputStep | { type?: string };

type GeminiInteraction = {
  id?: string;
  steps?: GeminiStep[];
};

// A null element is filtered out rather than dereferenced: a raw TypeError
// would reach the user through the loop's finish event, and this layer already
// has a considered message for a payload it cannot read.
const isFunctionCall = (step: GeminiStep): step is GeminiFunctionCallStep =>
  typeof step === "object" && step !== null && step.type === "function_call";

const isModelOutput = (step: GeminiStep): step is GeminiModelOutputStep =>
  typeof step === "object" && step !== null && step.type === "model_output";

const readSteps = (payload: unknown): GeminiStep[] => {
  const steps = (payload as GeminiInteraction | null)?.steps;
  return Array.isArray(steps) ? steps : [];
};

/**
 * The identifier the next turn continues.
 *
 * Its own type so a response that carried calls but no identifier is caught
 * here rather than becoming a request that silently starts a new conversation,
 * which the provider answers as a first turn with no idea what came before.
 */
const readInteractionId = (payload: unknown): string => {
  const id = (payload as GeminiInteraction | null)?.id;
  // A blank id is as unusable as a missing one: it would be posted back as
  // `previous_interaction_id` and the provider would reject the turn.
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("Gemini returned a computer-use turn with no interaction id");
  }
  return id;
};

/** This provider writes a point as two sibling numbers and never as a pair. */
const POINT: PointSpellings = { xKey: "x", yKey: "y", tupleKeys: [] };

const SCROLL_DIRECTIONS: ReadonlySet<string> = new Set([
  "up",
  "down",
  "left",
  "right",
]);

const readScrollDirection = (
  args: ComputerUseArguments,
): ComputerUseScrollDirection | undefined => {
  const value = readString(args, "direction");
  return value !== undefined && SCROLL_DIRECTIONS.has(value)
    ? (value as ComputerUseScrollDirection)
    : undefined;
};

/** The provider's own stated reason, which is not an argument to any action. */
const readIntent = (args: ComputerUseArguments): string | undefined =>
  readString(args, "intent");

const SAFETY_DECISIONS = new Set<ComputerUseSafetyDecision["decision"]>([
  "regular",
  "require_confirmation",
  "blocked",
]);

/**
 * The provider's own verdict on a call, when it issued one.
 *
 * A verdict the vocabulary does not recognise is discarded rather than passed
 * on as "no verdict", because the two mean opposite things: one is permission,
 * the other is this adapter failing to read the permission.
 */
const readSafety = (
  args: ComputerUseArguments,
): ComputerUseSafetyDecision | undefined => {
  const raw = args.safety_decision;
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const nested = raw as ComputerUseArguments;
  const decision = readString(nested, "decision");
  if (
    decision !== undefined &&
    !SAFETY_DECISIONS.has(decision as ComputerUseSafetyDecision["decision"])
  ) {
    // A verdict the vocabulary does not recognise is a refusal to guess. Reading
    // it as "no verdict" would be indistinguishable from a call that carried
    // none, and a refusal that failed to parse would silently become something
    // nobody was asked to approve.
    throw new Error(
      `The computer-use model returned a safety decision this app does not understand: ${decision}`,
    );
  }
  if (decision === undefined) {
    return undefined;
  }
  const explanation = readString(nested, "explanation");
  return {
    decision: decision as ComputerUseSafetyDecision["decision"],
    ...(explanation === undefined ? {} : { explanation }),
  };
};

/**
 * The scroll magnitude is stated in the same grid as a coordinate.
 *
 * That is what makes it convertible rather than a pixel count: a magnitude of
 * 300 on a 1000-wide grid is three tenths of the display, which on a wider
 * display is more pixels. Reading it as pixels instead would scroll a 2560-wide
 * display by the same distance as a 1280-wide one. The vertical axis is used
 * for a horizontal scroll and the reverse, because the grid is the same scale
 * on both and each scroll axis spans its own display extent.
 */
const gridMagnitudeToPixels = (
  magnitude: number,
  direction: ComputerUseScrollDirection,
  displayWidth: number,
  displayHeight: number,
): number =>
  Math.round(
    (magnitude / 1000) *
      (direction === "left" || direction === "right" ? displayWidth : displayHeight),
  );

const unsupported = (
  providerName: string,
  reason: string,
): ComputerUseAction => ({ type: "unsupported", providerName, reason });

/**
 * What the provider asked for, in the portable vocabulary.
 *
 * A member the environment does not offer, or an argument that did not arrive,
 * becomes an explicit refusal rather than a guess. Both outcomes matter to the
 * provider: it reads the failure and replans, whereas a defaulted coordinate
 * clicks something on the user's screen and is only noticed later, if at all.
 */
const mapFunctionCall = (
  name: string,
  args: ComputerUseArguments,
  displayWidth: number,
  displayHeight: number,
): ComputerUseAction => {
  const point = () => {
    const raw = readPoint(args, POINT);
    if (!raw) {
      return undefined;
    }
    return {
      x: denormalizeGridCoordinate(raw.x, displayWidth),
      y: denormalizeGridCoordinate(raw.y, displayHeight),
    };
  };
  const at = () => {
    const found = point();
    return found ? { type: "click" as const, ...found } : undefined;
  };
  const missingCoordinate = () =>
    unsupported(name, `${name} needs an x and y coordinate`);

  switch (name) {
    case "click":
      return at() ?? missingCoordinate();
    case "double_click":
    case "triple_click": {
      const found = at();
      if (!found) {
        return missingCoordinate();
      }
      return { ...found, clicks: name === "double_click" ? 2 : 3 };
    }
    case "right_click": {
      const found = at();
      return found ? { ...found, button: "right" } : missingCoordinate();
    }
    case "middle_click": {
      const found = at();
      return found ? { ...found, button: "middle" } : missingCoordinate();
    }
    case "mouse_down":
    case "mouse_up": {
      // The provider describes both members as acting AT a coordinate, so the
      // point is carried through rather than dropped. Discarding it would press
      // wherever the pointer happened to be left, which for a press-drag-release
      // means the drag starts somewhere the model never asked for.
      const found = point();
      if (!found) {
        return missingCoordinate();
      }
      return name === "mouse_down"
        ? { type: "mouse_down", ...found }
        : { type: "mouse_up", ...found };
    }
    case "move": {
      const found = point();
      return found ? { type: "move", ...found } : missingCoordinate();
    }
    case "type": {
      const text = readString(args, "text");
      if (text === undefined) {
        return unsupported(name, "type needs text");
      }
      const pressEnter = readBoolean(args, "press_enter");
      return pressEnter === undefined
        ? { type: "type", text }
        : { type: "type", text, pressEnter };
    }
    case "drag_and_drop": {
      const startX = readNumber(args, "start_x");
      const startY = readNumber(args, "start_y");
      const endX = readNumber(args, "end_x");
      const endY = readNumber(args, "end_y");
      if (
        startX === undefined ||
        startY === undefined ||
        endX === undefined ||
        endY === undefined
      ) {
        return unsupported(name, "drag needs start and end coordinates");
      }
      return {
        type: "drag",
        fromX: denormalizeGridCoordinate(startX, displayWidth),
        fromY: denormalizeGridCoordinate(startY, displayHeight),
        toX: denormalizeGridCoordinate(endX, displayWidth),
        toY: denormalizeGridCoordinate(endY, displayHeight),
      };
    }
    case "wait": {
      // The provider documents `seconds` as optional with a default of 1, so
      // an absent value is that default rather than a malformed request. A
      // value that IS present and unreadable is refused, which is the same
      // line the scroll case draws and for the same reason.
      const ms =
        args["seconds"] === undefined ? 1000 : readSecondsAsMs(args, "seconds", 300);
      return ms === undefined ? unsupported(name, "wait seconds must be a number") : { type: "wait", ms };
    }
    case "press_key": {
      const key = readString(args, "key");
      return key === undefined
        ? unsupported(name, "press_key needs a key")
        : { type: "key", keys: [key] };
    }
    case "key_down": {
      const key = readString(args, "key");
      return key === undefined
        ? unsupported(name, "key_down needs a key")
        : { type: "key_down", keys: [key] };
    }
    case "key_up": {
      const key = readString(args, "key");
      return key === undefined
        ? unsupported(name, "key_up needs a key")
        : { type: "key_up", keys: [key] };
    }
    case "hotkey": {
      const keys = readStringArray(args, "keys");
      return keys === undefined
        ? unsupported(name, "hotkey needs a key combination")
        : { type: "key", keys };
    }
    case "take_screenshot":
      return { type: "screenshot" };
    case "scroll": {
      const direction = readScrollDirection(args);
      const found = point();
      if (!direction || !found) {
        return unsupported(name, "scroll needs a direction and a coordinate");
      }
      // The magnitude is optional and the provider documents its own default of
      // 300 on the same 0-999 normalized grid as the coordinates. Applying that
      // documented default is the opposite of inventing a distance: a model
      // that omits the field asked for what the provider says an omission
      // means. Every other unreadable field here is refused, because no
      // provider defines a meaning for it.
      // The range is the provider's own (int, 0-999), so a magnitude outside it is
      // not a distance it offered. An absent value is its documented 300.
      const magnitude = readOptionalBoundedNumber(args, "magnitude_in_pixels", 0, 999);
      if (magnitude === null) {
        return unsupported(
          name,
          "scroll magnitude_in_pixels must be a number from 0 to 999",
        );
      }
      return {
        type: "scroll",
        direction,
        amount: gridMagnitudeToPixels(
          magnitude === undefined ? 300 : magnitude,
          direction,
          displayWidth,
          displayHeight,
        ),
      };
    }
    case "navigate":
    case "go_back":
    case "go_forward":
    case "open_app":
    case "list_apps":
    case "long_press":
      return unsupported(
        name,
        `this client drives the desktop, so ${name} is not something it can do`,
      );
    default:
      return unsupported(name, `Unsupported computer-use action ${name}`);
  }
};

/**
 * The scroll magnitude is stated in the same grid as a coordinate.
 *
 * That is what makes it convertible rather than a pixel count: a magnitude of
 * 300 on a 1000-wide grid is three tenths of the display, which on a wider
 * display is more pixels. Reading it as pixels instead would scroll a 2560-wide
 * display by the same distance as a 1280-wide one.
 */
const mapSteps = (
  steps: readonly GeminiStep[],
  displayWidth: number,
  displayHeight: number,
): ComputerUseTurn => {
  const actions: ComputerUseActionRequest[] = [];
  const texts: string[] = [];

  for (const step of steps) {
    if (isModelOutput(step)) {
      for (const block of step.content ?? []) {
        if (block?.type === "text" && block.text) {
          texts.push(block.text);
        }
      }
      continue;
    }
    if (!isFunctionCall(step) || typeof step.name !== "string") {
      continue;
    }
    const args = readArguments(step.arguments);
    // The provider's own identifier is what a later result must name, and its
    // documented response example includes a function_call with no `id` at all.
    // Inventing one does not paper over the gap: a result naming an
    // identifier the provider never issued does not answer its call, so the
    // next turn is rejected with an error about a malformed interaction rather
    // than about the missing id. Failing here says the actual cause.
    const callId = typeof step.id === "string" ? step.id.trim() : "";
    if (callId.length === 0) {
      throw new Error(
        `${LABEL} sent a ${step.name} action with no id, so its results could not be matched to it.`,
      );
    }
    actions.push({
      callId,
      providerName: step.name,
      action: mapFunctionCall(step.name, args, displayWidth, displayHeight),
      safety: readSafety(args),
      intent: readIntent(args),
    });
  }

  return { actions, text: texts.join("").trim() };
};

const imageContent = (screenshot: ComputerUseScreenshot) => ({
  type: "image" as const,
  data: screenshot.data,
  mime_type: screenshot.mimeType,
});

/**
 * One result, carrying the acknowledgement the provider demands.
 *
 * The acknowledgement is inside the result's own text rather than beside it
 * because that is where the provider reads it from, and it is only present
 * when a person actually approved the action. A result that claims approval the
 * user never gave would tell the provider its own safety check had passed.
 */
const functionResultContent = (
  result: ComputerUseAdvanceInput["results"][number],
  screenshot: ComputerUseScreenshot,
): unknown[] => {
  const payload: Record<string, unknown> = { outcome: describeResult(result) };
  if (result.userApproved) {
    payload.safety_acknowledgement = true;
  }
  return [
    { type: "text", text: JSON.stringify(payload) },
    imageContent(screenshot),
  ];
};

export type GeminiComputerUseConfig = {
  apiKey: string;
  model: string;
  environment: ComputerUseEnvironment;
  /** Scans screenshots for instructions hidden in the image. */
  enablePromptInjectionDetection?: boolean;
  customFetch?: CustomFetch;
  /** Called with each coordinate conversion, so a bad click can be traced. */
  onCoordinateTransform?: (detail: string) => void;
};

export const createGeminiComputerUseSession = (
  config: GeminiComputerUseConfig,
): ComputerUseSession => {
  // The member mapping below is the desktop one and the vocabulary has no
  // `navigate` at all, so a browser or mobile session cannot be carried out
  // here whatever the provider offers. Declaring the environment we can honour
  // beats silently asking the provider for a browser and then refusing its
  // browser members with a message about the desktop.
  if (config.environment !== "desktop") {
    throw new Error(
      `Gemini computer use is only wired up for the desktop; ${config.environment} would need its own action vocabulary`,
    );
  }
  const transport: ComputerUseTransport = buildComputerUseTransport(
    config.customFetch ?? fetch,
  );
  let interactionId: string | undefined;

  const turn = async (
    body: Record<string, unknown>,
    displayWidth: number,
    displayHeight: number,
    signal?: AbortSignal,
  ): Promise<ComputerUseTurn> => {
    config.onCoordinateTransform?.(
      `Gemini computer use on ${displayWidth}x${displayHeight} display, grid 0-${denormalizeGridCoordinate(1000, displayWidth) - 1}`,
    );
    const payload = await requestComputerUseTurn({
      transport,
      url: GEMINI_INTERACTIONS_URL,
      headers: { "x-goog-api-key": config.apiKey.trim() },
      body,
      label: LABEL,
      signal,
    });
    interactionId = readInteractionId(payload);
    const mapped = mapSteps(readSteps(payload), displayWidth, displayHeight);
    assertTurnHasContent(mapped);
    return mapped;
  };

  const toolConfig = () => [
    {
      type: "computer_use",
      environment: config.environment,
      ...(config.enablePromptInjectionDetection === undefined
        ? {}
        : { enable_prompt_injection_detection: config.enablePromptInjectionDetection }),
    },
  ];

  return {
    async start(
      input: ComputerUseTurnInput,
      signal?: AbortSignal,
    ): Promise<ComputerUseTurn> {
      assertScreenshotIsPng(input.screenshot);
      interactionId = undefined;
      return turn(
        {
          model: config.model,
          system_instruction: input.systemPrompt,
          input: [
            { type: "text", text: input.goal },
            imageContent(input.screenshot),
          ],
          tools: toolConfig(),
        },
        input.displayWidth,
        input.displayHeight,
        signal,
      );
    },

    async advance(
      input: ComputerUseAdvanceInput,
      signal?: AbortSignal,
    ): Promise<ComputerUseTurn> {
      assertScreenshotIsPng(input.screenshot);
      if (!interactionId) {
        throw new Error(
          "Gemini computer use advanced before it started. The provider continues a named interaction, so there is nothing to continue.",
        );
      }
      return turn(
        {
          model: config.model,
          previous_interaction_id: interactionId,
          input: input.results.map((result) => ({
            type: "function_result",
            name: result.providerName,
            call_id: result.callId,
            result: functionResultContent(result, input.screenshot),
          })),
          tools: toolConfig(),
        },
        input.displayWidth,
        input.displayHeight,
        signal,
      );
    },
  };
};

export const GEMINI_COMPUTER_USE_CAPABILITIES: ProviderCapabilities = {
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsVision: true,
  supportsComputerUse: true,
  supportsStructuredOutput: true,
  supportsThinking: true,
  computerUseEnvironment: "desktop",
};