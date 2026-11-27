import { useEffect } from "react";
import { keycapDashboardSize, keycapGrain } from "../../styles/keycap";
import { layoutKeycap } from "./keycap3d.geometry";
import { capRasterOptions } from "./keycap3d.raster";
import { requestCapRaster } from "./keycap3d.worker-client";

export const prewarmDashboardKeycap = (): void => {
  const options = capRasterOptions(
    layoutKeycap({ size: keycapDashboardSize, view: "front" }),
    keycapGrain,
    window.devicePixelRatio,
  );
  // Decorative prewarming never starts main-thread rendering or gates startup.
  requestCapRaster(options)?.catch(() => undefined);
};

export const usePrewarmDashboardKeycap = (): void => {
  useEffect(() => {
    const timer = setTimeout(prewarmDashboardKeycap, 0);
    return () => clearTimeout(timer);
  }, []);
};
