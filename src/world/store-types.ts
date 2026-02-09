import type { WorldId } from "./ids";

export type WorldStatus = "draft" | "active" | "archived" | "failed";

export type CharacterVisibility = "public" | "private";

export type WorldDraftMeta = {
  id: WorldId;
  homeGuildId: string;
  creatorId: string;
  name: string;
  status: "draft";
  createdAt: string;
  updatedAt: string;
  buildChannelId?: string;
};

export type WorldActiveMeta = {
  id: WorldId;
  homeGuildId: string;
  creatorId: string;
  name: string;
  status: Exclude<WorldStatus, "draft">;
  createdAt: string;
  updatedAt: string;
  roleId: string;
  categoryId: string;
  infoChannelId: string;
  joinChannelId?: string;
  roleplayChannelId: string;
  forumChannelId?: string;
  proposalsChannelId: string;
  voiceChannelId: string;
  buildChannelId?: string;
};

export type WorldMeta = WorldDraftMeta | WorldActiveMeta;

export type CharacterMeta = {
  id: number;
  creatorId: string;
  name: string;
  visibility: CharacterVisibility;
  status: "active" | "retired" | "failed";
  createdAt: string;
  updatedAt: string;
  buildChannelId?: string;
};
