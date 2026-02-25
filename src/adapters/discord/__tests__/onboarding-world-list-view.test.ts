import { describe, expect, test } from "bun:test";

import { buildOnboardingWorldListView } from "../onboarding-world-list-view";
import type { ActiveWorldEntry } from "../../../world/query";

function buildEntry(worldId: number): ActiveWorldEntry {
  return {
    meta: {
      id: worldId,
      homeGuildId: "g1",
      creatorId: "u1",
      name: `World-${worldId}`,
      status: "active",
      createdAt: "2026-02-25T00:00:00.000Z",
      updatedAt: "2026-02-25T00:00:00.000Z",
      roleId: `r${worldId}`,
      categoryId: `c${worldId}`,
      infoChannelId: `i${worldId}`,
      roleplayChannelId: `rp${worldId}`,
      proposalsChannelId: `p${worldId}`,
      voiceChannelId: `v${worldId}`,
    },
    card: `card-${worldId}`,
    stats: {
      version: 1,
      visitorCount: worldId,
      characterCount: worldId,
      updatedAt: "2026-02-25T00:00:00.000Z",
    },
  };
}

describe("buildOnboardingWorldListView", () => {
  test("keeps top worlds and paginates entries by 25", () => {
    const entries = Array.from({ length: 30 }, (_, idx) => buildEntry(idx + 1));
    const view = buildOnboardingWorldListView({ entries, page: 2 });

    expect(view.totalCount).toBe(30);
    expect(view.totalPages).toBe(2);
    expect(view.page).toBe(2);
    expect(view.topEntries.map((entry) => entry.meta.id)).toEqual([1, 2, 3]);
    expect(view.pageEntries.map((entry) => entry.meta.id)).toEqual([
      26, 27, 28, 29, 30,
    ]);
  });

  test("clamps invalid page values", () => {
    const entries = Array.from({ length: 8 }, (_, idx) => buildEntry(idx + 1));
    const view = buildOnboardingWorldListView({ entries, page: -10 });

    expect(view.totalPages).toBe(1);
    expect(view.page).toBe(1);
    expect(view.pageEntries).toHaveLength(8);
  });
});
