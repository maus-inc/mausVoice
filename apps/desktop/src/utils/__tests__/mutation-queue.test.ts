import { describe, it, expect } from "vitest";
import { createMutationQueue } from "../mutation-queue";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createMutationQueue", () => {
  it("runs tasks strictly in submission order", async () => {
    const { enqueue } = createMutationQueue();
    const order: string[] = [];

    const a = deferred();
    const b = deferred();

    const first = enqueue(() => a.promise.then(() => void order.push("A")));
    const second = enqueue(() => b.promise.then(() => void order.push("B")));

    // Resolve B before A to prove ordering is not a side-effect of resolution.
    b.resolve();
    a.resolve();

    await Promise.all([first, second]);
    expect(order).toEqual(["A", "B"]);
  });

  it("serializes overlapping enqueues (no interleaving)", async () => {
    const { enqueue } = createMutationQueue();
    let active = 0;
    let maxConcurrent = 0;

    const a = deferred();
    const b = deferred();
    const c = deferred();
    const aStarted = deferred();
    const bStarted = deferred();
    const cStarted = deferred();
    const aRelease = deferred();
    const bRelease = deferred();
    const cRelease = deferred();
    const make =
      (
        start: { promise: Promise<void> },
        entered: { resolve: (value: void) => void },
        release: { promise: Promise<void> },
      ) =>
      async () => {
        await start.promise;
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        entered.resolve();
        await release.promise;
        active -= 1;
      };

    const p1 = enqueue(make(a, aStarted, aRelease));
    const p2 = enqueue(make(b, bStarted, bRelease));
    const p3 = enqueue(make(c, cStarted, cRelease));

    b.resolve();
    c.resolve();
    a.resolve();

    await aStarted.promise;
    aRelease.resolve();
    await bStarted.promise;
    bRelease.resolve();
    await cStarted.promise;
    cRelease.resolve();

    await Promise.all([p1, p2, p3]);
    expect(maxConcurrent).toBe(1);
  });

  it("does not poison the chain when a task rejects", async () => {
    const { enqueue } = createMutationQueue();
    const ran: string[] = [];

    await expect(
      enqueue(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    await enqueue(() => {
      ran.push("after");
      return Promise.resolve();
    });

    expect(ran).toEqual(["after"]);
  });

  it("propagates the task return value to its caller", async () => {
    const { enqueue } = createMutationQueue();
    const result = await enqueue(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("propagates a task rejection to its caller", async () => {
    const { enqueue } = createMutationQueue();
    await expect(
      enqueue(() => Promise.reject(new Error("nope"))),
    ).rejects.toThrow("nope");
  });
});
