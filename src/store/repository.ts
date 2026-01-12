import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import type { Logger } from "pino";

import {
  DEFAULT_GROUP_CONFIG,
  GroupConfigSchema,
  type AgentContent,
  AgentFrontmatterSchema,
  type GroupConfig,
  type GroupData,
  type Skill,
} from "../types/group";

const DEFAULT_AGENT_MD = `# Agent

你是一个友好的助手。
`;

const DEFAULT_CONFIG_YAML = `# 群配置
enabled: true
triggerMode: mention
keywords: []
cooldown: 0
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
    const groupPath = join(this.dataDir, groupId);

    await mkdir(groupPath, { recursive: true });
    await mkdir(join(groupPath, "skills"), { recursive: true });
    await mkdir(join(groupPath, "context"), { recursive: true });
    await mkdir(join(groupPath, "assets"), { recursive: true });
    await mkdir(join(groupPath, "sessions"), { recursive: true });

    const agentPath = join(groupPath, "agent.md");
    if (!(await this.exists(agentPath))) {
      await writeFile(agentPath, DEFAULT_AGENT_MD);
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
      return { ...DEFAULT_GROUP_CONFIG };
    }

    try {
      const content = await readFile(configPath, "utf-8");
      const parsed = parseYaml(content);
      return GroupConfigSchema.parse(parsed);
    } catch (err) {
      this.logger.warn(
        { err, configPath },
        "Failed to parse config, using defaults",
      );
      return { ...DEFAULT_GROUP_CONFIG };
    }
  }

  async loadAgentPrompt(groupPath: string): Promise<AgentContent> {
    const agentPath = join(groupPath, "agent.md");

    if (!(await this.exists(agentPath))) {
      return { frontmatter: {}, content: "" };
    }

    try {
      const content = await readFile(agentPath, "utf-8");
      return this.parseAgentMd(content);
    } catch (err) {
      this.logger.warn({ err, agentPath }, "Failed to read agent.md");
      return { frontmatter: {}, content: "" };
    }
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

      const loadedSkills = await Promise.all(
        skillEntries.map(async (entry) => {
          const skillPath = join(skillsPath, entry.name);
          const content = await readFile(skillPath, "utf-8");
          const name = basename(entry.name, ".md");
          return {
            name,
            content: content.trim(),
            enabled: true,
          };
        }),
      );

      for (const skill of loadedSkills) {
        skills[skill.name] = skill;
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
