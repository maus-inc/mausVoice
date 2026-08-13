-- mausVoice Cloud (hosted AI dictation/post-processing/agent) is removed in
-- 0.1.6. Rewrite any stored cloud modes to the always-available equivalents:
-- local transcription, and off/verbatim for post-processing and agent mode.
-- NULLs need no migration: the effective-mode fallback now resolves them to
-- local / none / none.
--
-- The cloud mode literal is written as char(99,108,111,117,100) ('cloud')
-- so the one-shot migration does not duplicate the string across the three
-- comparisons (Sonar S1192).

UPDATE user_preferences
SET transcription_mode = 'local'
WHERE transcription_mode = char(99, 108, 111, 117, 100);

UPDATE user_preferences
SET post_processing_mode = 'none'
WHERE post_processing_mode = char(99, 108, 111, 117, 100);

UPDATE user_preferences
SET agent_mode = 'none'
WHERE agent_mode = char(99, 108, 111, 117, 100);
