import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Preview imports desktop source through an alias rather than a package import.
// Turbo therefore cannot infer that desktop's built workspace dependencies must
// exist before the preview compiles. Check the actual graph, not only its config.
const graph = (task: string) => {
  const root = resolve(process.cwd(), "../..");
  const json = execFileSync(
    process.execPath,
    [
      resolve(root, "node_modules/turbo/bin/turbo"),
      "run",
      task,
      "--dry=json",
      "--filter=@maus-inc/preview",
    ],
    { cwd: root, encoding: "utf8" },
  );
  return JSON.parse(json) as {
    tasks: Array<{ taskId: string; dependencies: string[] }>;
  };
};

describe("preview build graph", () => {
  it.each(["build", "check-types"])(
    "%s waits for desktop and its built workspace dependencies",
    (task) => {
      const tasks = graph(task).tasks;
      const preview = tasks.find(
        (item) => item.taskId === `@maus-inc/preview#${task}`,
      );
      expect(preview?.dependencies).toContain("desktop#build");
      const desktop = tasks.find((item) => item.taskId === "desktop#build");
      expect(desktop?.dependencies).toContain("@maus-inc/utilities#build");
      expect(desktop?.dependencies).toContain("@maus-inc/voice-ai#build");
    },
  );
});
