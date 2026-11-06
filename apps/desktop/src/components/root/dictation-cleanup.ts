import { getLogger } from "../../utils/log.utils";

/** Run one cleanup step without preventing the remaining releases. */
export function releaseRecordingResource(
  label: string,
  context: string,
  release: () => void | Promise<void>,
): void {
  const report = () => {
    try {
      getLogger().warning(`${label} cleanup failed ${context}`);
    } catch {
      // A failed log sink must not prevent the remaining releases.
    }
  };
  try {
    const result = release();
    if (result) void result.catch(report);
  } catch {
    report();
  }
}
