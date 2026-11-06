import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { SystemCapabilities } from "../types/system-capabilities.types";

let cachedPromise: Promise<SystemCapabilities | null> | null = null;

/**
 * One-shot, cached loader for the machine's RAM/CPU/GPU capabilities.
 * Values are static per boot, so the first caller warms the cache for
 * everyone else.
 */
export const loadSystemCapabilities =
  (): Promise<SystemCapabilities | null> => {
    cachedPromise ??= invoke<SystemCapabilities>(
      "get_system_capabilities",
    ).catch((error) => {
      console.error("Failed to load system capabilities:", error);
      return null;
    });
    return cachedPromise;
  };

export const useSystemCapabilities = (active = true) => {
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(
    null,
  );
  const [loading, setLoading] = useState(() => active);

  useEffect(() => {
    if (!active) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void loadSystemCapabilities().then((result) => {
      if (!cancelled) {
        setCapabilities(result);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [active]);

  return { capabilities, loading };
};
