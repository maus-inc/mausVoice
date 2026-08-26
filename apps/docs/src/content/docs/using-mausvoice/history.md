---
title: "Transcription history"
description: "Review saved raw and processed text, audio snapshots, and history privacy controls."
sidebar:
  order: 6
---

Choose **History** in the left navigation to review persisted transcriptions. Each row shows its timestamp and final text. Its actions let you open details, copy the final transcript, and delete the record. When a receiver is active, you can also send the text to that device. Received and sent records carry status chips.

History exists only when the current privacy settings permit it. **Incognito** prevents transcription history and audio snapshots from being saved. Outside Incognito, mausVoice attempts to save an audio snapshot with each ordinary transcription, but cleanup retains managed audio for only the 20 newest rows that have it. Older rows can therefore remain after their audio reference has been cleared, and an audio-write failure can also leave a row without playback.

## Inspect, replay, and export

Open the information action for the full pipeline record. Depending on what was captured, the dialog separates **Raw transcription**, **After replacements**, and **Final transcription**. It can also show warnings, transcription and post-processing durations, local model/device or API-key labels, operating modes, and the prompts used. A deleted key is reported as unknown rather than exposing an old secret.

A row with saved audio includes playback plus **Retranscribe** and **Export** actions. Retranscription runs the stored clip through the _currently selected_ transcription and post-processing configuration; you choose a language and one of the available styles, and the existing row is updated. It is not a read-only comparison, so export first if the old result matters.

Export opens a file picker and writes a ZIP named from the record ID. It contains `processed.txt`, includes `raw.txt` when raw text is present, and includes the managed clip as `audio.wav`. Treat that archive as sensitive.

## Edit and auto-learn

The **Final transcription** block in the details dialog has an Edit action. Use it to fix a misspelled name or term, then save. mausVoice persists the corrected text. When **More settings → Auto-learn dictionary** is on, it also adds the corrected words to your glossary terms automatically. A toast names the learned words so you can review or remove them in **Dictionary**.

Auto-learn is conservative. It only adds words that are new in the correction, look like a proper noun, and are not already in your dictionary. A large rewrite adds nothing.

## Diagnose with the three text stages

- If the raw text is wrong, investigate microphone quality, dictation language, glossary hints, and the transcription provider or local model.
- If raw text is right but **After replacements** is wrong, inspect replacement dictionary entries and symbol conversion.
- If replacement output is right but final text is wrong, inspect post-processing mode, selected key/model, and style prompt.
- If final text is correct but the target application is empty, investigate insertion and focus rather than reconfiguring speech recognition.

The row's delete action removes the database record and its managed audio path when one exists. There is no confirmation step in the current row action, so export anything you need first. **Settings → Danger zone → Clear local data** is a broader reset but, unlike per-row deletion, its current implementation does not remove the saved audio files. Enabling Incognito affects future saves; it does not retroactively erase existing rows.
