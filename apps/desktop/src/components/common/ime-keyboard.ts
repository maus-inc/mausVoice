import type { KeyboardEvent } from "react";

export const isComposingKey = (event: {
  isComposing: boolean;
  keyCode: number;
}) => event.isComposing || event.keyCode === 229;

/** Leave Escape to the input method instead of dismissing its enclosing dialog. */
export const stopComposingEscape = (event: KeyboardEvent) => {
  if (event.key === "Escape" && isComposingKey(event.nativeEvent)) {
    // Do not preventDefault: the input method still needs to handle the key.
    event.stopPropagation();
  }
};
