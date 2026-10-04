import { isElevationStartupReady } from "../actions/elevation.actions";
import { useAppStore } from "../store";

/** Subscribe to the elevation startup gate as a single ready flag. */
export const useElevationStartupReady = (): boolean =>
  useAppStore((state) =>
    isElevationStartupReady(state.settings.elevationStartupPending),
  );
