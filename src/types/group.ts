import { z } from "zod";

/**
 * Trigger mode for when the bot should respond
 */
export type TriggerMode = "mention" | "keyword";

export const KeywordRoutingSchema = z.object({
  enableGlobal: z.boolean().default(true),
  enableGroup: z.boolean().default(true),
  enableBot: z.boolean().default(true),
});

export type KeywordRouting = z.infer<typeof KeywordRoutingSchema>;

/**
 * Group configuration schema with zod validation
 */
export const GroupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  triggerMode: z.enum(["mention", "keyword"]).default("mention"),
  keywords: z.array(z.string()).default([]),
  keywordRouting: KeywordRoutingSchema.default({
    enableGlobal: true,
    enableGroup: true,
    enableBot: true,
  }),
  adminUsers: z.array(z.string()).default([]),
  maxSessions: z.number().int().min(1).default(1),
  model: z.string().optional(),
});

export type GroupConfig = z.infer<typeof GroupConfigSchema>;

/**
 * Skill definition
 */
export interface Skill {
  name: string;
  content: string;
  enabled: boolean;
}

/**
 * Complete group data
 */
export interface GroupData {
  id: string;
  path: string;
  config: GroupConfig;
  agentPrompt: string;
  skills: Record<string, Skill>;
}

/**
 * Agent.md frontmatter metadata
 */
export const AgentFrontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();

export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

/**
 * Parsed agent.md content
 */
export interface AgentContent {
  frontmatter: AgentFrontmatter;
  content: string;
}

/**
 * Default group config
 */
export const DEFAULT_GROUP_CONFIG: GroupConfig = {
  enabled: true,
  triggerMode: "mention",
  keywords: [],
  keywordRouting: {
    enableGlobal: true,
    enableGroup: true,
    enableBot: true,
  },
  adminUsers: [],
  maxSessions: 1,
};
