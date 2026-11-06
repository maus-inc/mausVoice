import { useEffect, useRef } from "react";
import { runStartupElevationPreflight } from "../actions/elevation.actions";
import { initLogging } from "../utils/log.utils";
import { getPlatform } from "../utils/platform.utils";
import {
  consumeSurfaceWindowFlag,
  surfaceMainWindow,
} from "../utils/window.utils";
import { useAsyncEffect } from "./async.hooks";

/** Start logging, the elevation preflight and any pending window surface request. */
export function useAppStartup(isMainWindow: boolean) {
  const attempted = useRef(false);
  useEffect(() => {
    initLogging().catch((error: unknown) => {
      console.warn("[AppSideEffects] logging init failed", error);
    });
  }, []);
  useAsyncEffect(async () => {
    if (attempted.current) return;
    attempted.current = true;
    await runStartupElevationPreflight({
      isMainWindow,
      platform: getPlatform(),
    });
  }, []);
  useAsyncEffect(async () => {
    if (consumeSurfaceWindowFlag()) await surfaceMainWindow();
  }, []);
}
