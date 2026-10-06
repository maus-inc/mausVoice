import type { ComputerUseAction, ToolRisk } from "@maus-inc/types";

/**
 * What a permission prompt needs to say about an action.
 *
 * The prompt is the only thing standing between a model that has decided to
 * click and a click that happens, so it describes the action rather than
 * repeating the name of the API call that asked for it.
 */
export type ComputerUseApproval = {
  risk: ToolRisk;
  /** One line, second person, no API vocabulary. */
  summary: string;
  /** A sentence naming what could go wrong, for the higher tiers. */
  warning?: string;
};

const plural = (count: number, word: string): string =>
  count === 1 ? `${count} ${word}` : `${count} ${word}s`;

const describePoint = (x: number, y: number): string => `at ${x}, ${y}`;

const describeKeys = (keys: readonly string[]): string =>
  keys.length === 1
    ? keys[0]
    : `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`;

/**
 * Classify one action.
 *
 * The tiers follow the same four every tool uses, so a computer-use prompt and
 * a tool prompt are read the same way. Reading is cheap; changing what is on
 * screen and where the pointer goes is not, which is why a click sits a tier
 * above a scroll even though both are single pointer events.
 */
export const classifyComputerUseAction = (
  action: ComputerUseAction,
): ComputerUseApproval => {
  switch (action.type) {
    case "screenshot":
      return {
        risk: "low",
        summary: "Look at the screen again",
        warning:
          "The screenshot stays on this machine until it reaches the model you chose.",
      };
    case "cursor_position":
      return { risk: "low", summary: "Check where the pointer is" };
    case "zoom":
      return {
        risk: "low",
        summary: "Take a closer look at part of the screen",
      };
    case "wait":
      return { risk: "low", summary: `Wait ${action.ms} milliseconds` };
    case "move":
      // Moving the pointer changes nothing by itself, which is why it is not
      // high. It is not low either, because a pointer resting on a button is
      // what makes the NEXT click land there, so a move is a decision the user
      // should see. It therefore asks, and carries the same warning as a
      // scroll for the same reason.
      return {
        risk: "medium",
        summary: `Move the pointer ${describePoint(action.x, action.y)}`,
        warning:
          "The pointer stays where you leave it, so the next click lands on whatever is under it.",
      };
    case "scroll":
      return {
        risk: "medium",
        summary: `Scroll ${action.direction} by ${action.amount} pixels`,
        warning:
          "This moves whatever is under the pointer, which may not be what you expect.",
      };
    case "type":
      return {
        risk: "high",
        summary: `Type ${plural(action.text.length, "character")} into whatever has focus`,
        warning:
          "The text goes to the focused window. If that is not the window you meant, nothing can undo it.",
      };
    case "key":
      return {
        risk: "high",
        summary: `Press ${describeKeys(action.keys)}${
          action.repeat ? ` ${action.repeat} times` : ""
        }`,
        warning:
          "A single keystroke can submit a form, close a document, or confirm a dialog you cannot see.",
      };
    case "key_down":
    case "key_up":
      return {
        risk: "high",
        summary: `${action.type === "key_down" ? "Hold down" : "Release"} ${describeKeys(
          action.keys,
        )}`,
        warning: "A held modifier changes what the next click does.",
      };
    case "click":
      return {
        risk: "high",
        summary: `Click ${plural(action.clicks ?? 1, "time")} ${describePoint(
          action.x,
          action.y,
        )} with the ${action.button ?? "left"} button${
          action.modifiers?.length
            ? ` while holding ${describeKeys(action.modifiers)}`
            : ""
        }`,
        warning:
          "Clicking can send a message, pay for something, or delete something. Check what is under the pointer first.",
      };
    case "mouse_down":
    case "mouse_up":
      return {
        risk: "high",
        summary: `${action.type === "mouse_down" ? "Press and hold" : "Release"} the ${
          action.button ?? "left"
        } mouse button`,
        warning:
          "A held button plus a small movement selects and drags text or files.",
      };
    case "drag":
      return {
        risk: "high",
        summary: `Drag from ${describePoint(action.fromX, action.fromY)} to ${describePoint(
          action.toX,
          action.toY,
        )}`,
        warning:
          "Dragging moves whatever it starts on. That can be a file, a window, or selected text.",
      };
    case "unsupported":
      return {
        risk: "low",
        summary: "Report an action this provider cannot do",
      };
  }
};

/**
 * Actions that touch the system and therefore need a decision.
 *
 * Reading the screen and waiting are not in this set, so they run without
 * interrupting the user. Everything that moves the pointer or sends a keystroke
 * is, including the ones that only move the pointer, because a pointer on top
 * of a button is how the next click goes somewhere unexpected.
 */
export const REQUIRES_APPROVAL: ReadonlySet<ComputerUseAction["type"]> =
  new Set([
    "move",
    "click",
    "mouse_down",
    "mouse_up",
    "drag",
    "type",
    "key",
    "key_down",
    "key_up",
    "scroll",
  ]);

export const needsComputerUseApproval = (action: ComputerUseAction): boolean =>
  REQUIRES_APPROVAL.has(action.type);
