// Adapter for expo-sqlite's synchronous API. Takes an open database, so this package does not
// depend on expo-sqlite itself:
//
//   import { openDatabaseSync } from "expo-sqlite";
//   await installPersistentIndexedDB({ sqlite: expoSqlite(openDatabaseSync("indexeddb.db")) });

import type { SyncSqlite } from "./index.ts";

/** The parts of expo-sqlite's `SQLiteDatabase` this uses. */
export interface ExpoSqliteDatabase {
  execSync(source: string): void;
  prepareSync(source: string): {
    executeSync(params: any[]): { getAllSync(): unknown[] };
  };
}

export function expoSqlite(db: ExpoSqliteDatabase): SyncSqlite {
  return {
    exec: (sql) => db.execSync(sql),
    prepare: (sql) => {
      const statement = db.prepareSync(sql);
      return {
        run: (params) => {
          statement.executeSync(params);
        },
        all: (params) => statement.executeSync(params).getAllSync() as Record<string, unknown>[],
      };
    },
  };
}
