import { getConfig } from "../config";
import type { SessionInfo } from "../types/session";

export interface OpencodeLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export class OpencodeLauncher {
  buildLaunchSpec(
    sessionInfo: SessionInfo,
    prompt: string,
  ): OpencodeLaunchSpec {
    const groupPath = sessionInfo.groupPath;
    const model = getConfig().OPENCODE_MODEL?.trim();
    const args = ["-p", prompt, "-c", groupPath, "-f", "json"];
    if (model) {
      args.push("-m", model);
    }
    return {
      command: "opencode",
      args,
      cwd: sessionInfo.workspacePath,
    };
  }
}
