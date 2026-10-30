import type { KeyboardEvent } from "react";

/** Leave Escape to the input method instead of dismissing its enclosing dialog. */
export const stopComposingEscape = (event: KeyboardEvent) => {
  if (
    event.key === "Escape" &&
    (event.nativeEvent.isComposing || event.keyCode === 229)
  ) {
    // Do not preventDefault: the input method still needs to handle the key.
    event.stopPropagation();
  }
};
