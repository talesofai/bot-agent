import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import type { Logger } from "pino";

import {
  GroupConfigSchema,
  type AgentContent,
  AgentFrontmatterSchema,
  type GroupConfig,
  type GroupData,
  type Skill,
} from "../types/group";
import { assertSafePathSegment } from "../utils/path";

const DEFAULT_AGENT_MD = `# Agent

你是一个友好的助手。
`;

const DEFAULT_CONFIG_YAML = `# 群配置
enabled: true
triggerMode: mention
keywords: []
keywordRouting:
  enableGlobal: true
  enableGroup: true
  enableBot: true
echoRate: null
adminUsers: []
maxSessions: 1
`;

export interface GroupFileRepositoryOptions {
  dataDir: string;
  logger: Logger;
}

export class GroupFileRepository {
  private dataDir: string;
  private logger: Logger;

  constructor(options: GroupFileRepositoryOptions) {
    this.dataDir = options.dataDir;
    this.logger = options.logger.child({ component: "group-repository" });
  }

  async ensureGroupDir(groupId: string): Promise<string> {
    assertSafePathSegment(groupId, "groupId");
    const groupPath = join(this.dataDir, groupId);

    await mkdir(groupPath, { recursive: true });
    await mkdir(join(groupPath, "skills"), { recursive: true });
    await mkdir(join(groupPath, "assets"), { recursive: true });
    await mkdir(join(groupPath, "assets", "images"), { recursive: true });

    const agentPath = join(groupPath, "agent.md");
    if (!(await this.exists(agentPath))) {
      const defaultAgent = groupId === "0" ? "" : DEFAULT_AGENT_MD;
      await writeFile(agentPath, defaultAgent);
      this.logger.debug({ groupId }, "Created default agent.md");
    }

    const configPath = join(groupPath, "config.yaml");
    if (!(await this.exists(configPath))) {
      await writeFile(configPath, DEFAULT_CONFIG_YAML);
      this.logger.debug({ groupId }, "Created default config.yaml");
    }

    return groupPath;
  }

  async loadGroup(groupId: string): Promise<GroupData | null> {
    assertSafePathSegment(groupId, "groupId");
    const groupPath = join(this.dataDir, groupId);

    if (!(await this.exists(groupPath))) {
      return null;
    }

    const [config, agentContent, skills] = await Promise.all([
      this.loadConfig(groupPath),
      this.loadAgentPrompt(groupPath),
      this.loadSkills(groupPath),
    ]);

    return {
      id: groupId,
      path: groupPath,
      config,
      agentPrompt: agentContent.content,
      skills,
    };
  }

  async loadConfig(groupPath: string): Promise<GroupConfig> {
    const configPath = join(groupPath, "config.yaml");

    if (!(await this.exists(configPath))) {
      throw new Error(`Missing config.yaml at ${configPath}`);
    }

    const content = await readFile(configPath, "utf-8");
    const parsed = parseYaml(content);
    return GroupConfigSchema.parse(parsed);
  }

  async loadAgentPrompt(groupPath: string): Promise<AgentContent> {
    const agentPath = join(groupPath, "agent.md");

    if (!(await this.exists(agentPath))) {
      throw new Error(`Missing agent.md at ${agentPath}`);
    }

    const content = await readFile(agentPath, "utf-8");
    return this.parseAgentMd(content);
  }

  parseAgentMd(content: string): AgentContent {
    try {
      const parsed = matter(content);
      let frontmatter = {};
      try {
        frontmatter = AgentFrontmatterSchema.parse(parsed.data);
      } catch (err) {
        this.logger.warn({ err }, "Invalid agent frontmatter");
      }
      return {
        frontmatter,
        content: parsed.content.trim(),
      };
    } catch (err) {
      this.logger.warn({ err }, "Failed to parse agent.md");
      return {
        frontmatter: {},
        content: content.trim(),
      };
    }
  }

  async loadSkills(groupPath: string): Promise<Record<string, Skill>> {
    const skillsPath = join(groupPath, "skills");

    if (!(await this.exists(skillsPath))) {
      return {};
    }

    const skills: Record<string, Skill> = {};

    try {
      const entries = await readdir(skillsPath, { withFileTypes: true });
      const skillEntries = entries.filter(
        (entry) => entry.isFile() && entry.name.endsWith(".md"),
      );

      for (const entry of skillEntries) {
        const skillPath = join(skillsPath, entry.name);
        try {
          const content = await readFile(skillPath, "utf-8");
          const name = basename(entry.name, ".md");
          skills[name] = {
            name,
            content: content.trim(),
            enabled: true,
          };
        } catch (err) {
          this.logger.warn({ err, skillPath }, "Failed to load skill file");
        }
      }
    } catch (err) {
      this.logger.warn({ err, skillsPath }, "Failed to load skills");
    }

    return skills;
  }

  private async exists(targetPath: string): Promise<boolean> {
    try {
      await access(targetPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
