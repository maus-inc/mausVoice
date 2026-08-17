import { describe, it, expect } from "vitest";
import { produce } from "immer";
import { INITIAL_APP_STATE } from "../state/app.state";
import { applyReplacedStyleHotkeys } from "../utils/style-hotkey";
import { SWITCH_TO_STYLE_HOTKEY_PREFIX } from "../utils/keyboard.utils";

const PREFIX = SWITCH_TO_STYLE_HOTKEY_PREFIX;

/**
 * Coverage notes / known gaps (documented per the code-review item):
 *  - The pure reducer below is the deterministic store mutation extracted from
 *    `StyleHotkeysDialog`. It is what this test exercises.
 *  - Duplicate-ID rejection for the *replacement set* (two `saved` entries
 *    sharing an id) is enforced by the Rust `hotkey_replace_style_hotkeys`
 *    command, not the TS reducer — that layer is NOT covered here.
 *  - "Native-sync failure leaves state consistent": by design the DB
 *    replacement commits in a single transaction and the in-memory native sync
 *    (`syncHotkeyCombosToNative`) failure is surfaced without rolling the
 *    store back. The reducer itself is the committed-state source of truth and
 *    is internally consistent (hotkeyById <-> hotkeyIds agree), which is what
 *    we assert. The in-flight guard ("a second replace while one is in flight")
 *    is the component-level `isSaving` flag, not the reducer.
 */

function stateWithStyleHotkeys(
  ids: { id: string; actionName: string }[],
): typeof INITIAL_APP_STATE {
  return produce(INITIAL_APP_STATE, (draft) => {
    for (const { id, actionName } of ids) {
      draft.hotkeyById[id] = { id, actionName, keys: ["Meta+K"] };
      draft.settings.hotkeyIds.push(id);
    }
  });
}

describe("applyReplacedStyleHotkeys", () => {
  it("deletes ALL existing style hotkeys when replacing with an empty set", () => {
    const start = stateWithStyleHotkeys([
      { id: "h1", actionName: `${PREFIX}tone-a` },
      { id: "h2", actionName: `${PREFIX}tone-b` },
      { id: "h3", actionName: "other-action" },
    ]);

    const result = produce(start, (draft) => {
      applyReplacedStyleHotkeys(draft, PREFIX, []);
    });

    expect(result.hotkeyById["h1"]).toBeUndefined();
    expect(result.hotkeyById["h2"]).toBeUndefined();
    expect(result.hotkeyById["h3"]).toBeDefined();
    expect(result.settings.hotkeyIds).not.toContain("h1");
    expect(result.settings.hotkeyIds).not.toContain("h2");
    expect(result.settings.hotkeyIds).toContain("h3");
  });

  it("replaces style hotkeys, registering the new set and removing the old", () => {
    const start = stateWithStyleHotkeys([
      { id: "old", actionName: `${PREFIX}tone-a` },
      { id: "keep", actionName: "other-action" },
    ]);
    const next = [
      { id: "new", actionName: `${PREFIX}tone-b`, keys: ["Meta+L"] },
    ];

    const result = produce(start, (draft) => {
      applyReplacedStyleHotkeys(draft, PREFIX, next);
    });

    expect(result.hotkeyById["old"]).toBeUndefined();
    expect(result.hotkeyById["keep"]).toBeDefined();
    expect(result.hotkeyById["new"]).toEqual({
      id: "new",
      actionName: `${PREFIX}tone-b`,
      keys: ["Meta+L"],
    });
    expect(result.settings.hotkeyIds).toContain("new");
    expect(result.settings.hotkeyIds).not.toContain("old");
    expect(result.settings.hotkeyIds).toContain("keep");
  });

  it("is idempotent: applying the same replacement twice does not duplicate ids", () => {
    const next = [{ id: "a", actionName: `${PREFIX}tone-a`, keys: ["Meta+A"] }];

    let result = produce(INITIAL_APP_STATE, (draft) => {
      applyReplacedStyleHotkeys(draft, PREFIX, next);
    });
    result = produce(result, (draft) => {
      applyReplacedStyleHotkeys(draft, PREFIX, next);
    });

    expect(result.settings.hotkeyIds.filter((id) => id === "a")).toHaveLength(
      1,
    );
    expect(
      Object.values(result.hotkeyById).filter((h) => h.id === "a"),
    ).toHaveLength(1);
  });

  it("leaves state consistent (hotkeyById and hotkeyIds agree) after replacement", () => {
    const next = [
      { id: "a", actionName: `${PREFIX}tone-a`, keys: ["Meta+A"] },
      { id: "b", actionName: `${PREFIX}tone-b`, keys: ["Meta+B"] },
    ];

    const result = produce(INITIAL_APP_STATE, (draft) => {
      applyReplacedStyleHotkeys(draft, PREFIX, next);
    });

    for (const id of result.settings.hotkeyIds) {
      expect(result.hotkeyById[id]).toBeDefined();
    }
    for (const hotkey of Object.values(result.hotkeyById)) {
      if (hotkey.actionName.startsWith(PREFIX)) {
        expect(result.settings.hotkeyIds).toContain(hotkey.id);
      }
    }
  });

  it("handles a second replacement that reuses the same ids without duplication", () => {
    const first = [
      { id: "a", actionName: `${PREFIX}tone-a`, keys: ["Meta+A"] },
    ];
    const second = [
      { id: "a", actionName: `${PREFIX}tone-a`, keys: ["Meta+Shift+A"] },
    ];

    let result = produce(INITIAL_APP_STATE, (draft) => {
      applyReplacedStyleHotkeys(draft, PREFIX, first);
    });
    result = produce(result, (draft) => {
      applyReplacedStyleHotkeys(draft, PREFIX, second);
    });

    expect(result.settings.hotkeyIds.filter((id) => id === "a")).toHaveLength(
      1,
    );
    expect(result.hotkeyById["a"].keys).toEqual(["Meta+Shift+A"]);
  });
});
