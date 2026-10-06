import { commands } from "@maus-inc/desktop-native-apis";
import type { ComputerUseHost } from "./computer-use-executor";

/**
 * The one place the generated bindings stop being a tagged union.
 *
 * Every binding returns `Result<T, string>`, which is the Rust
 * `Result<T, String>` rendered faithfully. The loop needs a rejected command to
 * read as a failure it can report and move on from, so the tag is collapsed
 * here rather than at every call site. A failure throws, and the executor
 * already catches that and turns it into `{ success: false }`, so this does not
 * change the loop's error discipline.
 */
const unwrap = <T>(
  result: { status: "ok"; data: T } | { status: "error"; error: string },
): T => {
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.data;
};

const unwrapUnit = async (pending: Promise<unknown>): Promise<void> => {
  unwrap(
    await (pending as Promise<
      { status: "ok"; data: null } | { status: "error"; error: string }
    >),
  );
};

export const tauriComputerUseHost: ComputerUseHost = {
  listDisplays: async () => unwrap(await commands.listDisplays()),
  captureScreen: async (request) =>
    unwrap(await commands.captureScreen(request)),
  captureScreenRegion: async (previous, region) =>
    unwrap(await commands.captureScreenRegion(previous, region)),
  computerUsePointerPosition: async () =>
    unwrap(await commands.computerUsePointerPosition()),
  computerUseMove: async (displayId, x, y) => {
    await unwrapUnit(commands.computerUseMove(displayId, x, y));
  },
  computerUseClick: async (displayId, x, y, button, clicks, modifiers) => {
    await unwrapUnit(
      commands.computerUseClick(displayId, x, y, button, clicks, modifiers),
    );
  },
  computerUsePressButton: async (button) => {
    await unwrapUnit(commands.computerUsePressButton(button));
  },
  computerUseReleaseButton: async (button) => {
    await unwrapUnit(commands.computerUseReleaseButton(button));
  },
  computerUseDrag: async (
    displayId,
    fromX,
    fromY,
    toX,
    toY,
    button,
    modifiers,
  ) => {
    await unwrapUnit(
      commands.computerUseDrag(
        displayId,
        fromX,
        fromY,
        toX,
        toY,
        button,
        modifiers,
      ),
    );
  },
  computerUseScroll: async (direction, amount, displayId, x, y) => {
    await unwrapUnit(
      commands.computerUseScroll(direction, amount, displayId, x, y),
    );
  },
  computerUsePressKey: async (chord, repeat, holdMs) => {
    await unwrapUnit(commands.computerUsePressKey(chord, repeat, holdMs));
  },
  computerUsePressKeyDown: async (chord) => {
    await unwrapUnit(commands.computerUsePressKeyDown(chord));
  },
  computerUseReleaseKeyUp: async (chord) => {
    await unwrapUnit(commands.computerUseReleaseKeyUp(chord));
  },
  computerUseType: async (text, pressEnter) => {
    await unwrapUnit(commands.computerUseType(text, pressEnter));
  },
  computerUseWait: async (durationMs) => {
    await unwrapUnit(commands.computerUseWait(durationMs));
  },
  computerUseCancel: async () => {
    await unwrapUnit(commands.computerUseCancel());
  },
  computerUseResetCancel: async () => {
    await unwrapUnit(commands.computerUseResetCancel());
  },
};
