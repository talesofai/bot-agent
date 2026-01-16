import { getConfig } from "../config";
import type { SessionInfo } from "../types/session";

export interface OpencodeLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  prompt?: string;
}

export class OpencodeLauncher {
  buildLaunchSpec(
    sessionInfo: SessionInfo,
    prompt: string,
    modelOverride?: string,
  ): OpencodeLaunchSpec {
    const config = getConfig();
    const maxPromptBytes = config.OPENCODE_PROMPT_MAX_BYTES;
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > maxPromptBytes) {
      throw new Error(
        `Prompt size ${promptBytes} exceeds OPENCODE_PROMPT_MAX_BYTES=${maxPromptBytes}`,
      );
    }

    const model = modelOverride?.trim() || config.OPENCODE_MODEL?.trim();
    const args = ["run", "--format", "json"];
    if (model) {
      args.push("-m", model);
    }
    args.push(
      "Use the attached prompt file as the full context and reply with the final answer only.",
    );
    return {
      command: "opencode",
      args,
      cwd: sessionInfo.workspacePath,
      prompt,
    };
  }
}
