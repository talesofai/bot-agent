import { constants } from "node:fs";
import { access, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getConfig } from "../config";
import { isSafePathSegment } from "../utils/path";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BUILTIN_SKILLS_DIR = path.join(PROJECT_ROOT, "configs", "skills");

export interface EnsureOpencodeSkillsOptions {
  workspacePath: string;
  groupId: string;
  botId: string;
}

export async function ensureOpencodeSkills(
  options: EnsureOpencodeSkillsOptions,
): Promise<void> {
  const config = getConfig();
  const dataRoot = resolveDataRoot(config);

  const sources: string[] = [
    BUILTIN_SKILLS_DIR,
    path.join(dataRoot, "global", "skills"),
  ];
  if (options.groupId !== "0") {
    sources.push(path.join(config.GROUPS_DATA_DIR, options.groupId, "skills"));
  }
  sources.push(path.join(dataRoot, "bots", options.botId, "skills"));

  const targetRoot = path.join(options.workspacePath, ".claude", "skills");
  await mkdir(targetRoot, { recursive: true });

  const builtinExists = await exists(BUILTIN_SKILLS_DIR);
  if (!builtinExists) {
    throw new Error(
      `Missing built-in skills directory at ${BUILTIN_SKILLS_DIR}; please include configs/skills in the image`,
    );
  }

  for (const sourceRoot of sources) {
    const skillNames = await listSkillDirs(sourceRoot);
    for (const skillName of skillNames) {
      const srcDir = path.join(sourceRoot, skillName);
      const destDir = path.join(targetRoot, skillName);
      await rm(destDir, { recursive: true, force: true });
      await cp(srcDir, destDir, { recursive: true });
    }
  }
}

function resolveDataRoot(config: ReturnType<typeof getConfig>): string {
  const explicit = config.DATA_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  return path.dirname(config.GROUPS_DATA_DIR);
}

async function listSkillDirs(root: string): Promise<string[]> {
  let rootStat: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    rootStat = await stat(root);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const skillDirs = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      isSafePathSegment(entry.name),
  );

  const results: string[] = [];
  for (const entry of skillDirs) {
    const skillDir = path.join(root, entry.name);
    const skillFile = path.join(skillDir, "SKILL.md");
    if (await exists(skillFile)) {
      results.push(entry.name);
    }
  }
  return results;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
