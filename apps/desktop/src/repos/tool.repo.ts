import type { ToolInfo } from "@maus-inc/types";
import { listRegisteredToolInfos } from "../tools";
import { BaseRepo } from "./base.repo";

/** Reads the same registry used to instantiate tools. */
export class ToolRepo extends BaseRepo {
  async listToolInfos(): Promise<ToolInfo[]> {
    return listRegisteredToolInfos();
  }
}
