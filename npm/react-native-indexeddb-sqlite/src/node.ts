// Adapter for Node's built-in `node:sqlite` (Node 22.5+), for tests and tooling:
//
//   import { DatabaseSync } from "node:sqlite";
//   await installPersistentIndexedDB({ sqlite: nodeSqlite(new DatabaseSync("indexeddb.db")) });

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { SyncSqlite } from "./index.ts";

export function nodeSqlite(db: DatabaseSync): SyncSqlite {
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (params) => {
          statement.run(...(params as SQLInputValue[]));
        },
        all: (params) => statement.all(...(params as SQLInputValue[])) as Record<string, unknown>[],
      };
    },
  };
}
