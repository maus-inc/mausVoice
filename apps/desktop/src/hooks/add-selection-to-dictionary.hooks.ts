import { invoke } from "@tauri-apps/api/core";
import { useCallback, useMemo } from "react";
import type { IntlShape } from "react-intl";
import { createGlossaryTerms } from "../actions/dictionary.actions";
import { getAppState } from "../store";
import { collectTermValues } from "../utils/app.utils";
import { ADD_TO_DICTIONARY_HOTKEY } from "../utils/keyboard.utils";
import { getLogger } from "../utils/log.utils";
import { createMutationQueue } from "../utils/mutation-queue";
import { sendPillFlashMessage } from "../utils/overlay.utils";
import { useHotkeyFire } from "./hotkey.hooks";

const MAX_SELECTED_TERM_LENGTH = 200;

async function addUniqueTerm(text: string, intl: IntlShape) {
  const existingTerms = collectTermValues(getAppState());
  if (
    existingTerms.some(
      (value) => value.trim().toLowerCase() === text.toLowerCase(),
    )
  ) {
    sendPillFlashMessage(
      intl.formatMessage(
        { defaultMessage: '"{text}" is already in your dictionary' },
        { text },
      ),
    );
    return;
  }
  // This action owns optimistic persistence, rollback and the onboarding checklist.
  const { created, failed } = await createGlossaryTerms([text]);
  if (created.length > 0) {
    sendPillFlashMessage(
      intl.formatMessage(
        { defaultMessage: 'Added "{text}" to dictionary' },
        { text },
      ),
    );
  } else if (failed > 0) {
    sendPillFlashMessage(
      intl.formatMessage({
        defaultMessage:
          "Could not add the selection to your dictionary. Please try again.",
      }),
    );
  }
}

/** Capture each selection promptly, but serialize duplicate checking and persistence. */
export function useAddSelectionToDictionary({
  isMainWindow,
  intl,
}: {
  isMainWindow: boolean;
  intl: IntlShape;
}) {
  const queue = useMemo(() => createMutationQueue(), []);
  const onFire = useCallback(async () => {
    try {
      const selectedText = await invoke<string | null>("get_selected_text");
      if (!selectedText?.trim()) return;
      const text = selectedText.trim();
      if (text.length > MAX_SELECTED_TERM_LENGTH) {
        sendPillFlashMessage(
          intl.formatMessage({
            defaultMessage:
              "The selection is too long to add to the dictionary.",
          }),
        );
        return;
      }
      await queue.enqueue(() => addUniqueTerm(text, intl));
    } catch (error) {
      getLogger().error(`Failed to add to dictionary: ${error}`);
    }
  }, [intl, queue]);
  useHotkeyFire({
    actionName: ADD_TO_DICTIONARY_HOTKEY,
    isDisabled: !isMainWindow,
    onFire,
  });
}
