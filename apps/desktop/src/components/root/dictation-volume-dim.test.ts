import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  verboseMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: mocks.invoke,
}));
vi.mock("../../utils/log.utils", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    verbose: mocks.verboseMock,
  }),
}));

import { createSystemVolumeDim } from "./dictation-volume-dim";

const SYSTEM_VOLUME = 0.8;
const DIM_LEVEL = 0.5;
const DIMMED_VOLUME = SYSTEM_VOLUME * DIM_LEVEL;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

const deferred = <T>(): Deferred<T> => {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** Lets every pending microtask of an in-flight dim run. */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

type VolumeWorld = {
  /** The volume the OS last applied, which is what the user is left hearing. */
  volume: number;
  /** Every write that has landed, in the order it landed. */
  landed: number[];
};

const installVolumeWorld = (
  options: {
    read?: () => Promise<number>;
    /**
     * Writes held back until the matching deferred resolves, in call order. A
     * write with no deferred left lands immediately.
     */
    deferWrites?: Deferred<void>[];
  } = {},
): VolumeWorld => {
  const world: VolumeWorld = { volume: SYSTEM_VOLUME, landed: [] };
  const gates = [...(options.deferWrites ?? [])];
  mocks.invoke.mockImplementation((command: string, args?: unknown) => {
    if (command === "get_system_volume") {
      return options.read?.() ?? Promise.resolve(SYSTEM_VOLUME);
    }
    if (command === "set_system_volume") {
      const { volume } = args as { volume: number };
      const gate = gates.shift() ?? null;
      if (!gate) {
        world.volume = volume;
        world.landed.push(volume);
        return Promise.resolve(undefined);
      }
      return gate.promise.then(() => {
        world.volume = volume;
        world.landed.push(volume);
      });
    }
    throw new Error(`unexpected command: ${command}`);
  });
  return world;
};

const buildDim = (options: { dimLevel?: number } = {}) => {
  const preDimVolumeRef: { current: number | null } = { current: null };
  const volumeDim = createSystemVolumeDim({
    preDimVolumeRef,
    getDimLevel: () => options.dimLevel ?? DIM_LEVEL,
  });
  return { ...volumeDim, preDimVolumeRef };
};

describe("createSystemVolumeDim", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.verboseMock.mockReset();
  });

  it("dims for a live recording and leaves the restore to the stop", async () => {
    const world = installVolumeWorld();
    const { dim, endRecording } = buildDim();

    await dim(1);

    expect(world.volume).toBe(DIMMED_VOLUME);

    endRecording();

    expect(world.volume).toBe(SYSTEM_VOLUME);
  });

  it("leaves the volume alone when dimming is off", async () => {
    const world = installVolumeWorld();
    const { dim, endRecording } = buildDim({ dimLevel: 1.0 });

    await dim(1);
    endRecording();

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(world.volume).toBe(SYSTEM_VOLUME);
  });

  it("does not dim when the stop lands while the volume read is in flight", async () => {
    // The dim has not written anything yet, so the stop has no restore point to
    // put back. Applying the dim after that stop is what left system audio
    // dimmed for the rest of the session.
    const read = deferred<number>();
    const world = installVolumeWorld({ read: () => read.promise });
    const { dim, endRecording } = buildDim();

    const dimming = dim(1);
    await flush();
    endRecording();
    read.resolve(SYSTEM_VOLUME);
    await dimming;

    expect(world.landed).toEqual([]);
    expect(world.volume).toBe(SYSTEM_VOLUME);
  });

  it("puts its own dim back when the stop lands while the dim write is in flight", async () => {
    // The stop spends the shared restore point, so the dim that is still writing
    // has to put the volume back itself. Going through the shared ref here found
    // nothing left to restore and the dimmed volume stood.
    const dimWrite = deferred<void>();
    const world = installVolumeWorld({ deferWrites: [dimWrite] });
    const { dim, endRecording } = buildDim();

    const dimming = dim(1);
    await flush();
    endRecording();
    dimWrite.resolve();
    await dimming;

    expect(world.volume).toBe(SYSTEM_VOLUME);
  });

  it("undoes its own dim without clearing a restore point a newer recording owns", async () => {
    // The stale dim has to write back the volume it displaced, but the ref in it
    // now belongs to the recording that replaced it, so undoing must neither
    // spend that ref nor write over the volume that recording dimmed to.
    const staleDimWrite = deferred<void>();
    const world = installVolumeWorld({ deferWrites: [staleDimWrite] });
    const { dim, preDimVolumeRef } = buildDim();

    const staleDim = dim(1);
    await flush();
    // The recording is replaced mid-dim: the replacement claims the restore
    // point and dims for its own length while the stale dim is still writing.
    preDimVolumeRef.current = SYSTEM_VOLUME;
    await dim(2);
    staleDimWrite.resolve();
    await staleDim;

    expect(world.volume).toBe(DIMMED_VOLUME);
    expect(preDimVolumeRef.current).toBe(SYSTEM_VOLUME);
  });

  it("dims again for the recording that follows the one that ended", async () => {
    // The generation is the dim's own end marker, not a one-shot: the next
    // dictation has to dim for its own length, not inherit the retired dim.
    const world = installVolumeWorld();
    const { dim, endRecording } = buildDim();

    await dim(1);
    endRecording();
    await dim(2);

    expect(world.volume).toBe(DIMMED_VOLUME);
  });

  it("reports a failed volume read instead of dimming from nothing", async () => {
    mocks.invoke.mockRejectedValue(new Error("no audio device"));
    const { dim, preDimVolumeRef } = buildDim();

    await expect(dim(1)).resolves.toBeUndefined();

    expect(preDimVolumeRef.current).toBeNull();
    expect(mocks.verboseMock).toHaveBeenCalledWith(
      expect.stringContaining("Failed to dim system volume"),
    );
  });

  it("restores the volume it read even when the recording ended mid-dim", async () => {
    const world = installVolumeWorld();
    const { dim, endRecording } = buildDim();

    const dimming = dim(1);
    await flush();
    endRecording();
    await dimming;

    expect(world.landed).toEqual([DIMMED_VOLUME, SYSTEM_VOLUME]);
  });
});
