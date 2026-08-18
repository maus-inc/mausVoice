/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

/**
 * Early fatal-overlay handler registered by the inline pre-bundle script in
 * `apps/desktop/index.html` and removed by `installGlobalErrorOverlay`
 * (`src/utils/global-error-overlay.utils.ts`) once the bundle owns error
 * surfacing. The property name is set as a string literal in index.html —
 * keep the two spellings in sync when renaming.
 */
interface Window {
  __mausVoiceEarlyUnhandledRejection?: (event: PromiseRejectionEvent) => void;
}

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_FIREBASE_MEASUREMENT_ID: string;
  readonly VITE_USE_EMULATORS?: string;
  readonly VITE_FLAVOR?: string;
  readonly VITE_NEW_SERVER_URL?: string;
  readonly VITE_ENTERPRISE_ROUTING_URL_OVERRIDE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
