import { ActivationController } from "@maus-inc/desktop-utils";

export { ActivationController } from "@maus-inc/desktop-utils";

const lastToggleByKey = new Map<string, number>();

export function debouncedToggle(
  key: string,
  controller: ActivationController,
): void {
  const now = Date.now();
  const lastToggle = lastToggleByKey.get(key) ?? 0;
  if (now - lastToggle < 100) {
    return;
  }
  lastToggleByKey.set(key, now);
  controller.toggle();
}
