export type DiscordOnboardingIdentityRoleConfig = {
  worldCreaterRoleIds: string[];
  adventurerRoleIds: string[];
  /** Lowercased; matched by substring (contains). */
  worldCreaterRoleNameIncludes: string[];
  /** Lowercased; matched by substring (contains). */
  adventurerRoleNameIncludes: string[];
};

export type DiscordIdentityRoles = {
  worldCreater: boolean;
  adventurer: boolean;
};

function parseCsv(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeLower(input: string): string {
  return input.trim().toLowerCase();
}

function anyRoleNameIncludes(
  memberRoleNamesLower: string[],
  needlesLower: string[],
): boolean {
  if (needlesLower.length === 0) {
    return false;
  }
  return memberRoleNamesLower.some((name) =>
    needlesLower.some((needle) => needle && name.includes(needle)),
  );
}

export function buildDiscordOnboardingIdentityRoleConfig(input: {
  creatorRoleIdsRaw?: string | null;
  playerRoleIdsRaw?: string | null;
  creatorRoleNamesRaw?: string | null;
  playerRoleNamesRaw?: string | null;
}): DiscordOnboardingIdentityRoleConfig {
  const worldCreaterRoleIds = parseCsv(input.creatorRoleIdsRaw).filter((id) =>
    /^\d+$/.test(id),
  );
  const adventurerRoleIds = parseCsv(input.playerRoleIdsRaw).filter((id) =>
    /^\d+$/.test(id),
  );
  const worldCreaterRoleNameIncludes = parseCsv(input.creatorRoleNamesRaw).map(
    normalizeLower,
  );
  const adventurerRoleNameIncludes = parseCsv(input.playerRoleNamesRaw).map(
    normalizeLower,
  );
  return {
    worldCreaterRoleIds,
    adventurerRoleIds,
    worldCreaterRoleNameIncludes,
    adventurerRoleNameIncludes,
  };
}

export function resolveDiscordIdentityRoles(input: {
  memberRoleIds: string[];
  memberRoleNames: string[];
  config: DiscordOnboardingIdentityRoleConfig;
}): DiscordIdentityRoles {
  const roleIdSet = new Set(input.memberRoleIds.map((id) => id.trim()));
  const roleNamesLower = input.memberRoleNames
    .map(normalizeLower)
    .filter(Boolean);

  const hasExplicitConfig =
    input.config.worldCreaterRoleIds.length > 0 ||
    input.config.adventurerRoleIds.length > 0 ||
    input.config.worldCreaterRoleNameIncludes.length > 0 ||
    input.config.adventurerRoleNameIncludes.length > 0;

  // Heuristics (fallback): try to match common role names from Discord onboarding options.
  const heuristicWorldCreater = roleNamesLower.some(
    (name) =>
      name.includes("worldbuilder") ||
      name.includes("writer") ||
      name.includes("creator") ||
      name.includes("world creator") ||
      name.includes("world creater") ||
      name.includes("creater") ||
      name.includes("创作者") ||
      name.includes("写手"),
  );
  const heuristicAdventurer = roleNamesLower.some(
    (name) =>
      name.includes("roleplay") ||
      name.includes("explore") ||
      name.includes("player") ||
      name.includes("adventurer") ||
      name.includes("玩家") ||
      name.includes("跑团"),
  );

  if (hasExplicitConfig) {
    const configWorldCreater =
      input.config.worldCreaterRoleIds.some((id) => roleIdSet.has(id)) ||
      anyRoleNameIncludes(
        roleNamesLower,
        input.config.worldCreaterRoleNameIncludes,
      );
    const configAdventurer =
      input.config.adventurerRoleIds.some((id) => roleIdSet.has(id)) ||
      anyRoleNameIncludes(
        roleNamesLower,
        input.config.adventurerRoleNameIncludes,
      );
    return {
      worldCreater: configWorldCreater || heuristicWorldCreater,
      adventurer: configAdventurer || heuristicAdventurer,
    };
  }

  return {
    worldCreater: heuristicWorldCreater,
    adventurer: heuristicAdventurer,
  };
}
