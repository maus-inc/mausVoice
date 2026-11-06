import { spawnSync } from "node:child_process";

/** Summarize commits after the newest reachable release tag, if git succeeds. */
export function autoReleaseNotes(tag, runGit = spawnSync) {
  try {
    const tags = runGit(
      "git",
      [
        "for-each-ref",
        "refs/tags/mausVoice-v*",
        "--merged=HEAD",
        "--sort=-version:refname",
        "--format=%(refname:short)",
      ],
      { encoding: "utf8" },
    );
    if (tags.error || tags.status !== 0) return null;
    const previous = (tags.stdout ?? "")
      .split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate && candidate !== tag);
    const log = runGit(
      "git",
      [
        "log",
        previous ? `${previous}..HEAD` : "HEAD",
        "--no-merges",
        "--format=%s",
      ],
      { encoding: "utf8" },
    );
    if (log.error || log.status !== 0 || !log.stdout?.trim()) return null;
    return log.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => `- ${line.replace(/^[a-z]+(\([^)]*\))?:\s*/i, "")}`)
      .join("\n");
  } catch {
    return null;
  }
}
