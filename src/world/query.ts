import type { WorldStatsV1 } from "./file-store";
import type { WorldActiveMeta, WorldMeta } from "./store";

export interface WorldQueryStore {
  listWorldIds(limit?: number): Promise<number[]>;
  getWorld(worldId: number): Promise<WorldMeta | null>;
}

export interface WorldQueryFiles {
  readWorldCard(worldId: number): Promise<string | null>;
  readStats(worldId: number): Promise<WorldStatsV1>;
}

export type ActiveWorldEntry = {
  meta: WorldActiveMeta;
  card: string | null;
  stats: WorldStatsV1;
};

export async function listActiveWorldEntries(input: {
  worldStore: WorldQueryStore;
  worldFiles: WorldQueryFiles;
  limit?: number;
  sortBy?: "created_at_desc" | "visitors_desc";
}): Promise<ActiveWorldEntry[]> {
  const ids = await input.worldStore.listWorldIds(input.limit ?? 50);
  if (ids.length === 0) {
    return [];
  }

  const metas = await Promise.all(
    ids.map((id) => input.worldStore.getWorld(id)),
  );
  const active = metas.filter((meta): meta is WorldActiveMeta =>
    Boolean(meta && meta.status === "active"),
  );
  if (active.length === 0) {
    return [];
  }

  const entries = await Promise.all(
    active.map(async (meta) => {
      const [card, stats] = await Promise.all([
        input.worldFiles.readWorldCard(meta.id).catch(() => null),
        input.worldFiles.readStats(meta.id),
      ]);
      return { meta, card, stats };
    }),
  );

  if (input.sortBy === "visitors_desc") {
    entries.sort((left, right) => {
      const byVisitors = right.stats.visitorCount - left.stats.visitorCount;
      if (byVisitors !== 0) {
        return byVisitors;
      }
      return right.meta.id - left.meta.id;
    });
  }
  return entries;
}
