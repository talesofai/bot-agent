import postgres, { type Sql } from "postgres";

export interface PostgresClientOptions {
  databaseUrl: string;
  maxConnections?: number;
}

export function createPostgresClient(options: PostgresClientOptions): Sql {
  return postgres(options.databaseUrl, {
    max: options.maxConnections ?? 10,
  });
}
