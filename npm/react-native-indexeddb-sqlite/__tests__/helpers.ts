import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  installPersistentIndexedDB,
  type InstallOptions,
  type PersistentIndexedDB,
  type SyncSqlite,
} from "../src/index.ts";
import { nodeSqlite } from "../src/node.ts";

export function tempDatabaseFile(): string {
  return join(mkdtempSync(join(tmpdir(), "idb-sqlite-")), "indexeddb.db");
}

/**
 * A fresh instance on `file`, as after an app restart: nothing in memory, everything loaded from
 * SQLite. `wrap` lets a test interfere with the SQLite adapter.
 */
export async function start(
  file: string,
  options: Partial<InstallOptions> & { wrap?: (sqlite: SyncSqlite) => SyncSqlite } = {},
): Promise<PersistentIndexedDB> {
  const sqlite = nodeSqlite(new DatabaseSync(file));
  return installPersistentIndexedDB({
    target: null,
    ...options,
    sqlite: options.wrap ? options.wrap(sqlite) : sqlite,
  });
}

export function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("aborted"));
  });
}

export function open(
  factory: IDBFactory,
  name: string,
  version?: number,
  upgrade?: (db: IDBDatabase, transaction: IDBTransaction, oldVersion: number) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name, version);
    r.onupgradeneeded = (event) => upgrade?.(r.result, r.transaction!, event.oldVersion);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Every record of a store or index, in key order, as [key, value] pairs. */
export function entries(
  source: IDBObjectStore | IDBIndex,
  query?: IDBKeyRange,
): Promise<[IDBValidKey, unknown][]> {
  return new Promise((resolve, reject) => {
    const out: [IDBValidKey, unknown][] = [];
    const r = source.openCursor(query);
    r.onsuccess = () => {
      const cursor = r.result;
      if (!cursor) return resolve(out);
      out.push([cursor.key, cursor.value]);
      cursor.continue();
    };
    r.onerror = () => reject(r.error);
  });
}
