interface mausVoiceEnv {
  MAUSVOICE_GATEWAY_URL?: string;
  MAUSVOICE_APP_NAME?: string;
}

declare global {
  interface Window {
    __MAUSVOICE__?: mausVoiceEnv;
  }
}

export function getGatewayUrl(): string {
  return window.__MAUSVOICE__?.MAUSVOICE_GATEWAY_URL || "http://localhost:4630";
}

export function isDev(): boolean {
  return import.meta.env.DEV;
}

export function getAppName(): string {
  return window.__MAUSVOICE__?.MAUSVOICE_APP_NAME || "mausVoice Enterprise";
}

export function getAppVersion(): string {
  return import.meta.env.VITE_VERSION || "0.0.1";
}
