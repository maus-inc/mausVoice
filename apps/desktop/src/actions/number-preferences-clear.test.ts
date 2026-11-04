import { expect, it } from "vitest";
import {
  beginLocalDataClear,
  LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY,
} from "../utils/local-data-write-gate";
import {
  setDictationLimitMinutes,
  setHandsFreeDelayMs,
} from "./user-settings.actions";

it("rejects number saves blocked by a local-data clear", async () => {
  const release = await beginLocalDataClear();
  try {
    await expect(setDictationLimitMinutes(10)).rejects.toThrow(
      "write is blocked",
    );
    await expect(setHandsFreeDelayMs(3000)).rejects.toThrow("write is blocked");
  } finally {
    localStorage.removeItem(LOCAL_DATA_CLEAR_PENDING_STORAGE_KEY);
    release();
  }
});
