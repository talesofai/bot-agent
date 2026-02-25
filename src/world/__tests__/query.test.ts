import { describe, expect, test } from "bun:test";

import { listActiveWorldEntries } from "../query";
import type { WorldStatsV1 } from "../file-store";
import type { WorldMeta } from "../store";

function buildStats(
  visitorCount: number,
  characterCount: number,
): WorldStatsV1 {
  return {
    version: 1,
    visitorCount,
    characterCount,
    updatedAt: "2026-02-25T00:00:00.000Z",
  };
}

describe("listActiveWorldEntries", () => {
  test("filters active worlds and sorts by visitors then world id", async () => {
    const metas = new Map<number, WorldMeta>([
      [
        1,
        {
          id: 1,
          homeGuildId: "g1",
          creatorId: "u1",
          name: "W1",
          status: "active",
          createdAt: "2026-02-25T00:00:00.000Z",
          updatedAt: "2026-02-25T00:00:00.000Z",
          roleId: "r1",
          categoryId: "c1",
          infoChannelId: "i1",
          roleplayChannelId: "rp1",
          proposalsChannelId: "p1",
          voiceChannelId: "v1",
        },
      ],
      [
        2,
        {
          id: 2,
          homeGuildId: "g1",
          creatorId: "u1",
          name: "W2",
          status: "active",
          createdAt: "2026-02-25T00:00:00.000Z",
          updatedAt: "2026-02-25T00:00:00.000Z",
          roleId: "r2",
          categoryId: "c2",
          infoChannelId: "i2",
          roleplayChannelId: "rp2",
          proposalsChannelId: "p2",
          voiceChannelId: "v2",
        },
      ],
      [
        3,
        {
          id: 3,
          homeGuildId: "g1",
          creatorId: "u1",
          name: "W3",
          status: "draft",
          createdAt: "2026-02-25T00:00:00.000Z",
          updatedAt: "2026-02-25T00:00:00.000Z",
        },
      ],
      [
        4,
        {
          id: 4,
          homeGuildId: "g1",
          creatorId: "u1",
          name: "W4",
          status: "active",
          createdAt: "2026-02-25T00:00:00.000Z",
          updatedAt: "2026-02-25T00:00:00.000Z",
          roleId: "r4",
          categoryId: "c4",
          infoChannelId: "i4",
          roleplayChannelId: "rp4",
          proposalsChannelId: "p4",
          voiceChannelId: "v4",
        },
      ],
    ]);
    let requestedLimit = 0;
    const statsByWorld = new Map<number, WorldStatsV1>([
      [1, buildStats(2, 3)],
      [2, buildStats(5, 1)],
      [4, buildStats(5, 9)],
    ]);

    const result = await listActiveWorldEntries({
      limit: 77,
      sortBy: "visitors_desc",
      worldStore: {
        async listWorldIds(limit?: number): Promise<number[]> {
          requestedLimit = limit ?? 0;
          return [1, 2, 3, 4];
        },
        async getWorld(worldId: number): Promise<WorldMeta | null> {
          return metas.get(worldId) ?? null;
        },
      },
      worldFiles: {
        async readWorldCard(worldId: number): Promise<string | null> {
          if (worldId === 2) {
            throw new Error("bad card");
          }
          return `card-${worldId}`;
        },
        async readStats(worldId: number): Promise<WorldStatsV1> {
          return statsByWorld.get(worldId) ?? buildStats(0, 0);
        },
      },
    });

    expect(requestedLimit).toBe(77);
    expect(result.map((entry) => entry.meta.id)).toEqual([4, 2, 1]);
    expect(result.map((entry) => entry.card)).toEqual([
      "card-4",
      null,
      "card-1",
    ]);
  });

  test("keeps worldStore order when sortBy is not provided", async () => {
    const result = await listActiveWorldEntries({
      worldStore: {
        async listWorldIds(): Promise<number[]> {
          return [9, 7, 8];
        },
        async getWorld(worldId: number): Promise<WorldMeta | null> {
          return {
            id: worldId,
            homeGuildId: "g1",
            creatorId: "u1",
            name: `W${worldId}`,
            status: "active",
            createdAt: "2026-02-25T00:00:00.000Z",
            updatedAt: "2026-02-25T00:00:00.000Z",
            roleId: `r${worldId}`,
            categoryId: `c${worldId}`,
            infoChannelId: `i${worldId}`,
            roleplayChannelId: `rp${worldId}`,
            proposalsChannelId: `p${worldId}`,
            voiceChannelId: `v${worldId}`,
          };
        },
      },
      worldFiles: {
        async readWorldCard(worldId: number): Promise<string | null> {
          return `card-${worldId}`;
        },
        async readStats(): Promise<WorldStatsV1> {
          return buildStats(1, 1);
        },
      },
    });

    expect(result.map((entry) => entry.meta.id)).toEqual([9, 7, 8]);
  });
});
