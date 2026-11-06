import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AgentToolOutput } from "../src/types";

const execAsync = promisify(exec);

/** Execute only after the user has explicitly approved the exact command. */
export async function runConfirmedCommand(
  command: string,
  reason: string,
  confirm: (message: string) => Promise<boolean>,
  run: (
    command: string,
    options: { timeout: number },
  ) => Promise<{ stdout: string; stderr: string }> = execAsync,
): Promise<AgentToolOutput> {
  const allowed = await confirm(`Execute "${command}"?\n  Reason: ${reason}`);
  if (!allowed)
    return { success: false, failureReason: "User denied the command." };
  try {
    const { stdout, stderr } = await run(command, { timeout: 30000 });
    return {
      success: true,
      result: { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 },
    };
  } catch (error: unknown) {
    const detail = error as { stderr?: string; message?: string };
    return {
      success: false,
      failureReason:
        detail?.stderr?.trim() || detail?.message || "Command failed",
    };
  }
}
