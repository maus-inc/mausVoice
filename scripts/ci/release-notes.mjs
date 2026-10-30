import { readFile } from "node:fs/promises";

/** Preserve Markdown structure while normalizing transport whitespace. */
export const normalizeReleaseNotes = (notes) =>
  (notes ?? "").replace(/\r\n?/g, "\n").trim();

/** An explicit artifact is authoritative; missing files must fail the release. */
export const readReleaseNotes = async (env = process.env) =>
  normalizeReleaseNotes(
    env.RELEASE_NOTES_FILE
      ? await readFile(env.RELEASE_NOTES_FILE, "utf8")
      : env.RELEASE_NOTES,
  );
