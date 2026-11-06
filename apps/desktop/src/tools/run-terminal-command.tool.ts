import { invoke } from "@tauri-apps/api/core";
import type { ToolInfo } from "@maus-inc/types";
import { BaseTool, type ToolResult } from "./base.tool";

type RunTerminalCommandResponse = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export class RunTerminalCommandTool extends BaseTool {
  constructor(info: ToolInfo) {
    super(info);
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command as string;
    const result = await invoke<RunTerminalCommandResponse>(
      "run_terminal_command",
      { command },
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
}
