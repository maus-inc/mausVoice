type RecordingTransport = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

type Activity = { browser: object | null; native: Set<object> };
const activities = new WeakMap<RecordingTransport, Activity>();

function activityFor(transport: RecordingTransport): Activity {
  let activity = activities.get(transport);
  if (!activity) {
    activity = { browser: null, native: new Set() };
    activities.set(transport, activity);
  }
  return activity;
}

// This guard only covers one webview; the native coordinator remains
// authoritative across windows for both browser and native recording leases.
export function acquireLocalNativeRecording(
  transport: RecordingTransport,
  owner: object,
): boolean {
  const activity = activityFor(transport);
  if (activity.browser) return false;
  activity.native.add(owner);
  return true;
}

export function releaseLocalNativeRecording(
  transport: RecordingTransport,
  owner: object,
): void {
  activityFor(transport).native.delete(owner);
}

export function acquireLocalBrowserRecording(
  transport: RecordingTransport,
  owner: object,
): boolean {
  const activity = activityFor(transport);
  if (activity.browser || activity.native.size) return false;
  activity.browser = owner;
  return true;
}

export function releaseLocalBrowserRecording(
  transport: RecordingTransport,
  owner: object,
): void {
  const activity = activityFor(transport);
  if (activity.browser === owner) activity.browser = null;
}
