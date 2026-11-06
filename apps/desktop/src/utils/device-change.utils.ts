/** Subscribe to `devicechange`; returns unsubscribe or undefined when unsupported. */
export const subscribeDeviceChange = (
  mediaDevices:
    | {
        addEventListener: (type: string, listener: () => void) => void;
        removeEventListener: (type: string, listener: () => void) => void;
      }
    | undefined
    | null,
  onChange: () => void,
): (() => void) | undefined => {
  if (!mediaDevices) {
    return undefined;
  }
  mediaDevices.addEventListener("devicechange", onChange);
  return () => {
    mediaDevices.removeEventListener("devicechange", onChange);
  };
};
