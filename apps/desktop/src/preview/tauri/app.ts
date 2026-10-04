// Every `@tauri-apps/api/app` accessor is promise-returning in the real API, so
// these shims keep that shape rather than handing callers a bare value.
export const getVersion = (): Promise<string> =>
  Promise.resolve("0.1.6-preview");

export const getName = (): Promise<string> =>
  Promise.resolve("mausVoice Preview");

export const getTauriVersion = (): Promise<string> =>
  Promise.resolve("2.0.0-preview");

export const getIdentifier = (): Promise<string> =>
  Promise.resolve("com.mausvoice.preview");

export const hide = (): Promise<void> => Promise.resolve();
export const show = (): Promise<void> => Promise.resolve();
