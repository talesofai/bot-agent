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
    return {
      command: "opencode",
      args: ["-p", prompt, "-c", groupPath, "-f", "json"],
      cwd: sessionInfo.workspacePath,
    };
  }
}
