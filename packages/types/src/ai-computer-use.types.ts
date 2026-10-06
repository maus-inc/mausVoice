/**
 * Computer use, as a portable vocabulary.
 *
 * Two providers drive a desktop through this type and neither of them can be
 * reduced to the other's wire format. Anthropic declares a client toolset and
 * expects one `tool_result` block per `tool_use` block, each echoing the
 * toolset name. Gemini returns function calls on a session endpoint where each
 * turn names the interaction it continues, and carries a safety verdict on each
 * call. Neither shape fits the generic chat transport, so both are reached
 * through `ComputerUseSession` and the conversation itself never learns which
 * provider it is talking to.
 */

/**
 * What the model is being asked to drive.
 *
 * The three values are the environment identifiers both protocols accept, and
 * they are not interchangeable. A browser environment offers navigation that a
 * desktop environment does not, and a mobile environment offers app launching
 * that neither of the others does.
 */
export type ComputerUseEnvironment = "browser" | "desktop" | "mobile";

/** Mouse buttons the portable vocabulary can ask for. */
export type ComputerUseMouseButton = "left" | "right" | "middle";

/** Scroll axes the portable vocabulary can ask for. */
export type ComputerUseScrollDirection = "up" | "down" | "left" | "right";

/**
 * What a provider can do, so the loop can choose a conversation shape without
 * naming a provider.
 *
 * Every field is a fact about the wire protocol rather than a guess about model
 * behaviour, so each one can be read off the provider's own documentation and
 * asserted in a test without a network call.
 */
export type ProviderCapabilities = {
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsVision: boolean;
  supportsComputerUse: boolean;
  supportsStructuredOutput: boolean;
  supportsThinking: boolean;
  /**
   * Required when `supportsComputerUse` is true, because the protocol declares
   * the environment on the request rather than inferring it. Omitting it sends
   * a request the provider answers with the wrong action set.
   */
  computerUseEnvironment?: ComputerUseEnvironment;
};

/**
 * A screenshot handed to a computer-use model.
 *
 * `width` and `height` are the pixel dimensions of `data` itself, not of the
 * display it was captured from. A provider expresses coordinates in the space
 * of the image the model was shown, so the two sizes have to stay separate or a
 * downscaled capture sends every click to the wrong place.
 */
export type ComputerUseScreenshot = {
  /** Base64 encoded bytes. A byte array cannot cross the IPC boundary. */
  data: string;
  mimeType: "image/jpeg" | "image/png";
  /** Pixel width of `data`. */
  width: number;
  /** Pixel height of `data`. */
  height: number;
};

/** A screen region in physical pixels, top-left and bottom-right corners. */
export type ComputerUseRegion = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

/**
 * One desktop action in the vocabulary both providers are translated into.
 *
 * Coordinates are physical pixels on the display. A provider's own coordinate
 * space is a detail of its session and is resolved before an action reaches
 * this type. A scaling mistake here clicks the wrong thing and reports no
 * error, which is why every session logs the transformation it applies.
 */
export type ComputerUseAction =
  | { type: "screenshot" }
  | { type: "cursor_position" }
  | { type: "zoom"; region: ComputerUseRegion }
  | { type: "move"; x: number; y: number }
  | {
      type: "click";
      x: number;
      y: number;
      button?: ComputerUseMouseButton;
      clicks?: 1 | 2 | 3;
      /** Held for the duration of this action only. */
      modifiers?: readonly string[];
    }
  | {
      type: "mouse_down";
      /**
       * Physical pixels. Present when the provider names a point, which
       * Gemini does; the pointer is moved there before the button goes down.
       * Absent when the provider leaves the press wherever the pointer already
       * is, which Anthropic does. Refusing the absent case would break that
       * provider, and inventing a point would move the pointer to a place the
       * model never asked for.
       */
      x?: number;
      y?: number;
      button?: ComputerUseMouseButton;
    }
  | {
      type: "mouse_up";
      /** See {@link ComputerUseAction} `mouse_down`. */
      x?: number;
      y?: number;
      button?: ComputerUseMouseButton;
    }
  | {
      type: "drag";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
      /** Held for the duration of this action only. */
      modifiers?: readonly string[];
    }
  | { type: "key_down"; keys: readonly string[] }
  | { type: "key_up"; keys: readonly string[] }
  | { type: "type"; text: string; pressEnter?: boolean }
  | {
      type: "key";
      keys: readonly string[];
      /** 1 to 100. Providers that cannot repeat ignore this. */
      repeat?: number;
      /** Press, hold for this long, release. */
      holdMs?: number;
    }
  | {
      type: "scroll";
      direction: ComputerUseScrollDirection;
      /**
       * Distance in physical pixels, because a provider that expresses the
       * scroll in wheel clicks is converted on the way in. Keeping pixels here
       * means the executor never has to know which provider asked.
       */
      amount: number;
    }
  | { type: "wait"; ms: number }
  | {
      /**
       * The provider asked for something this client cannot perform.
       *
       * Both providers add members over time, and Anthropic adds them without
       * a version bump to the toolset name. Dropping the request instead would
       * leave the conversation with an unanswered call, which both providers
       * reject outright, so an unknown member has to travel to the loop as a
       * value the loop can answer with a failure.
       */
      type: "unsupported";
      /** The provider's own name for the member, for the failure message. */
      providerName: string;
      reason: string;
    };

/** Every action name in the portable vocabulary, for exhaustive dispatch. */
export const COMPUTER_USE_ACTION_TYPES = [
  "screenshot",
  "cursor_position",
  "zoom",
  "move",
  "click",
  "mouse_down",
  "mouse_up",
  "drag",
  "key_down",
  "key_up",
  "type",
  "key",
  "scroll",
  "wait",
  "unsupported",
] as const satisfies readonly ComputerUseAction["type"][];

/**
 * A provider's verdict on one action.
 *
 * Only some providers classify their own actions, so this is absent for the
 * rest. It is never the only gate on an action. The permission tier decides
 * whether the user is asked, and a provider verdict can add a gate on top of
 * that.
 */
export type ComputerUseSafetyDecision = {
  decision: "regular" | "require_confirmation" | "blocked";
  explanation?: string;
};

/**
 * An action the model asked for, with the provider's identifier for the
 * request that asked for it.
 *
 * `callId` is load-bearing rather than diagnostic. Both providers reject the
 * whole conversation when a request has no matching result, so the identifier
 * has to survive from the response through execution and back.
 */
export type ComputerUseActionRequest = {
  callId: string;
  /** Provider-native member name, kept for result matching. */
  providerName: string;
  action: ComputerUseAction;
  safety?: ComputerUseSafetyDecision;
  /** The provider's own stated reason for the action, when it gives one. */
  intent?: string;
};

/** What happened when one action was executed. */
export type ComputerUseActionResult = {
  /** Matches `ComputerUseActionRequest.callId`. */
  callId: string;
  /** Matches `ComputerUseActionRequest.providerName`. */
  providerName: string;
  success: boolean;
  /** Human-readable outcome, shown back to the model. */
  message: string;
  /**
   * Set when the action was stopped before it ran, which is not the same as an
   * action that ran and failed. Providers replan differently for each, and
   * collapsing them makes a refusal look like a defect worth retrying around.
   */
  skipped?: boolean;
  /**
   * The user approved this specific action after being shown what it would do.
   *
   * Some providers attach their own safety verdict to a call and require an
   * acknowledgement back on the result before they will accept it. A provider
   * that has no such verdict simply never reads this.
   */
  userApproved?: boolean;
};

/** One provider turn, read into the portable shape. */
export type ComputerUseTurn = {
  /** Actions in the order the provider listed them. Empty ends the task. */
  actions: readonly ComputerUseActionRequest[];
  /** Prose the provider produced alongside its actions. */
  text: string;
};

/** What a computer-use model needs to make its first decision. */
export type ComputerUseTurnInput = {
  /** Assistant instructions for the task. */
  systemPrompt: string;
  /** What the user asked for, in the user's own words. */
  goal: string;
  screenshot: ComputerUseScreenshot;
  /**
   * Physical pixel bounds of the display being driven. Distinct from the
   * screenshot's size on purpose: a provider whose coordinates are relative to
   * the image needs both to reach the display.
   */
  displayWidth: number;
  displayHeight: number;
};

/**
 * The outcome of a batch of actions, plus a fresh screenshot.
 *
 * `results` carries one entry per action the model asked for, in the same
 * order and with the same identifiers, because an unanswered request is a
 * rejected conversation rather than a shorter one.
 */
export type ComputerUseAdvanceInput = {
  results: readonly ComputerUseActionResult[];
  /**
   * The state to show the model next.
   *
   * Both providers require PNG here even where they accept JPEG on the opening
   * screenshot, so a computer-use run captures PNG for its whole loop rather
   * than re-encoding per turn.
   */
  screenshot: ComputerUseScreenshot;
  displayWidth: number;
  displayHeight: number;
};

/**
 * One computer-use conversation, held in whatever state its provider needs.
 *
 * This interface is why the loop has no provider branches. Anthropic is
 * stateless and resends its whole message list each turn; Gemini continues a
 * named interaction. A caller holding a session runs the same conversation
 * either way and cannot act on the difference.
 */
export interface ComputerUseSession {
  /** Open the conversation and take the first turn. */
  start(
    input: ComputerUseTurnInput,
    signal?: AbortSignal,
  ): Promise<ComputerUseTurn>;
  /** Answer the previous turn's actions and take the next one. */
  advance(
    input: ComputerUseAdvanceInput,
    signal?: AbortSignal,
  ): Promise<ComputerUseTurn>;
}

/**
 * Opens conversations for one provider under one set of credentials.
 *
 * A registry of these is how a provider is added. The loop holds sessions, so
 * picking between providers is a lookup over a registry rather than a branch on
 * a provider name inside the conversation.
 */
export interface ComputerUseSessionFactory {
  /** The provider identifier the rest of the app already uses. */
  readonly providerId: string;
  /** Matches `ProviderCapabilities.computerUseEnvironment`. */
  readonly environment: ComputerUseEnvironment;
  readonly capabilities: ProviderCapabilities;
  /**
   * Opens a conversation. The factory carries the credentials, so nothing above
   * it has to know where they came from.
   */
  create(): ComputerUseSession;
}