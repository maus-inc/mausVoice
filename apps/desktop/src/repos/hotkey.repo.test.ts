import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { LocalHotkeyRepo } from "./hotkey.repo";

const hotkey = (keys: string[]) => ({ id: "one", actionName: "dictate", keys });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("LocalHotkeyRepo write ordering", () => {
  it("waits for prior writes before reading hotkeys across instances", async () => {
    let finish!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const write = new LocalHotkeyRepo().saveHotkey(hotkey(["Q"]));
    const read = new LocalHotkeyRepo().listHotkeys();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke.mock.calls[0][0]).toBe("hotkey_save");
    finish();
    await Promise.all([write, read]);
    expect(invoke.mock.calls[1][0]).toBe("hotkey_list");
  });

  it("allows a read after an earlier write fails", async () => {
    invoke.mockRejectedValueOnce(new Error("write failed"));
    invoke.mockResolvedValueOnce([]);
    const repo = new LocalHotkeyRepo();
    const write = repo.saveHotkey(hotkey(["Q"]));
    const read = repo.listHotkeys();
    await expect(write).rejects.toThrow("write failed");
    await expect(read).resolves.toEqual([]);
  });

  it("persists rapid updates and a deletion in invocation order across instances", async () => {
    let completeFirst!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeFirst = resolve;
        }),
    );
    const first = new LocalHotkeyRepo();
    const second = new LocalHotkeyRepo();
    const a = first.saveHotkey(hotkey(["Control"]));
    const b = second.saveHotkey(hotkey(["Control", "Q"]));
    const c = first.deleteHotkey("one");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    completeFirst();
    await Promise.all([a, b, c]);
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      "hotkey_save",
      "hotkey_save",
      "hotkey_delete",
    ]);
    expect(invoke.mock.calls[1][1].hotkey.keys).toEqual(["Control", "Q"]);
  });

  it("queues and snapshots a dictation language replacement as one write", async () => {
    let complete!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const repo = new LocalHotkeyRepo();
    const old = repo.saveHotkey(hotkey(["Q"]));
    const primary = hotkey(["A"]);
    const extra = [
      { id: "fr", actionName: "additional-language:fr", keys: ["F"] },
    ];
    const replacing = repo.replaceDictationLanguageHotkeys(primary, extra, [
      hotkey(["old"]),
    ]);
    primary.keys.push("B");
    extra[0].keys.push("G");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    complete();
    await Promise.all([old, replacing]);
    expect(invoke.mock.calls[1]).toEqual([
      "hotkey_replace_dictation_language_hotkeys",
      {
        primary: hotkey(["A"]),
        expected: [hotkey(["old"])],
        additional: [
          { id: "fr", actionName: "additional-language:fr", keys: ["F"] },
        ],
      },
    ]);
  });

  it("continues after a failed write and snapshots queued replacement data", async () => {
    let rejectFirst!: (error: Error) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    const repo = new LocalHotkeyRepo();
    const first = repo.saveHotkey(hotkey(["Control"]));
    const failure = expect(first).rejects.toThrow("disk error");
    const styles = [hotkey(["Alt", "S"])];
    const expected = [hotkey(["old"])];
    const replacement = repo.replaceStyleHotkeys("style:", styles, expected);
    styles[0].keys.push("M");
    expected[0].keys.push("changed");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    rejectFirst(new Error("disk error"));
    await failure;
    await replacement;
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][0]).toBe("hotkey_replace_style_hotkeys");
    expect(invoke.mock.calls[1][1].hotkeys[0].keys).toEqual(["Alt", "S"]);
    expect(invoke.mock.calls[1][1].expected).toEqual([hotkey(["old"])]);
  });
});
