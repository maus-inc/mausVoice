// The Tauri OS plugin exposes synchronous getters. Keep that contract so
// shared UI copy (for example permission instructions) renders consistently.
export const platform = (): "macos" => "macos";
export const type = (): "Darwin" => "Darwin";
export const version = (): string => "preview";
export const arch = (): string => "x86_64";
