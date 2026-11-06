// A persistent IndexedDB for React Native: fake-indexeddb (a spec-compliant, in-memory
// implementation) with a write-through SQLite layer.
//
// - Reads never touch SQLite; fake-indexeddb serves them from memory.
// - When an IndexedDB transaction commits, every record it touched is written to SQLite in one
//   SQLite transaction, before `complete` fires. If that write fails, the IndexedDB transaction
//   aborts instead (memory rolled back, `abort` fired), as a real implementation's would.
// - A database is loaded from SQLite the first time it is opened, deleted, or listed. Indexes
//   are not stored; they are rebuilt from the records on load.
//
// The layer hooks fake-indexeddb internals (ObjectStore, Database, Index, FDBTransaction), so
// fake-indexeddb is pinned to the version it was written against.

// The values are fake-indexeddb's classes; the types are the standard DOM ones they implement.
import {
  IDBCursor as FakeIDBCursor,
  IDBCursorWithValue as FakeIDBCursorWithValue,
  IDBDatabase as FakeIDBDatabase,
  IDBFactory as FakeIDBFactory,
  IDBIndex as FakeIDBIndex,
  IDBKeyRange as FakeIDBKeyRange,
  IDBObjectStore as FakeIDBObjectStore,
  IDBOpenDBRequest as FakeIDBOpenDBRequest,
  IDBRequest as FakeIDBRequest,
  IDBTransaction as FakeIDBTransaction,
  IDBVersionChangeEvent as FakeIDBVersionChangeEvent,
} from "fake-indexeddb";

import { decodeKey, decodeValue, encodeKey, encodeValue } from "./encoding.ts";

export { decodeKey, decodeValue, encodeKey, encodeValue } from "./encoding.ts";

export interface SyncStatement {
  run(params: unknown[]): void;
  all(params: unknown[]): Record<string, unknown>[];
}

/** The synchronous SQLite surface the layer needs; see the `/expo` and `/node` adapters. */
export interface SyncSqlite {
  exec(sql: string): void;
  prepare(sql: string): SyncStatement;
}

export interface PersistenceStats {
  /** Databases loaded from SQLite, records loaded, and the time it took. */
  hydratedDatabases: number;
  hydratedRecords: number;
  hydrateMs: number;
  /** IndexedDB transactions written to SQLite, the records written and deleted, and the time it took. */
  commits: number;
  writtenRecords: number;
  deletedRecords: number;
  commitMs: number;
  /** Transactions aborted because writing them to SQLite failed. */
  failedCommits: number;
}

export interface InstallOptions {
  sqlite: SyncSqlite;
  /**
   * Where to define `indexedDB` and the `IDB*` classes. Defaults to `globalThis`; pass `null` to
   * define nothing and use the returned factory directly.
   */
  target?: object | null;
  /**
   * SQLite's `synchronous` setting (the journal is always WAL). `NORMAL`, the default, survives an
   * app crash but can lose the last transactions on a power loss; `FULL` survives both and is slower.
   */
  synchronous?: "NORMAL" | "FULL";
  /** Called when writing a transaction to SQLite fails (the transaction is then aborted). */
  onCommitError?: (error: unknown) => void;
}

export interface PersistentIndexedDB {
  factory: IDBFactory;
  stats: PersistenceStats;
}

// fake-indexeddb's internal objects are untyped here on purpose: the hooks below read and write
// their private fields.
type Raw = any;

interface StoreSchema {
  id: number;
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  keyGenerator: number | null;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
}

interface DatabaseSchema {
  version: number;
  stores: StoreSchema[];
}

interface Pending {
  cleared: boolean;
  keys: Map<string, unknown>;
}

interface Internals {
  Database: Raw;
  ObjectStore: Raw;
  Index: Raw;
}

function prepareStatements(sqlite: SyncSqlite) {
  const prepare = (sql: string) => sqlite.prepare(sql);
  return {
    databases: prepare("SELECT name, schema FROM idb_database"),
    schema: prepare("SELECT schema FROM idb_database WHERE name = ?"),
    putSchema: prepare("INSERT OR REPLACE INTO idb_database (name, schema) VALUES (?, ?)"),
    deleteSchema: prepare("DELETE FROM idb_database WHERE name = ?"),
    records: prepare("SELECT key, value FROM idb_record WHERE store = ?"),
    putRecord: prepare("INSERT OR REPLACE INTO idb_record (store, key, value) VALUES (?, ?, ?)"),
    deleteRecord: prepare("DELETE FROM idb_record WHERE store = ? AND key = ?"),
    deleteStore: prepare("DELETE FROM idb_record WHERE store = ?"),
  };
}

class Persistence {
  readonly factory: Raw = new FakeIDBFactory();
  readonly stats: PersistenceStats = {
    hydratedDatabases: 0,
    hydratedRecords: 0,
    hydrateMs: 0,
    commits: 0,
    writtenRecords: 0,
    deletedRecords: 0,
    commitMs: 0,
    failedCommits: 0,
  };
  private readonly sqlite: SyncSqlite;
  private readonly internals: Internals;
  private readonly onCommitError: (error: unknown) => void;
  private readonly sql: ReturnType<typeof prepareStatements>;
  private readonly storeIds = new WeakMap<Raw, number>();
  private readonly persistedStoreIds = new Map<string, Set<number>>();
  private readonly pending = new WeakMap<unknown[], Map<Raw, Pending>>();
  private nextStoreId = 1;

  constructor(options: InstallOptions, internals: Internals) {
    this.sqlite = options.sqlite;
    this.internals = internals;
    this.onCommitError =
      options.onCommitError ??
      ((error) => console.error("react-native-indexeddb-sqlite: commit failed", error));
    this.sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = ${options.synchronous === "FULL" ? "FULL" : "NORMAL"};
      CREATE TABLE IF NOT EXISTS idb_database (name TEXT PRIMARY KEY, schema TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idb_record (
        store INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key)
      ) WITHOUT ROWID;
    `);
    this.sql = prepareStatements(this.sqlite);
    // Store ids are stable across renames; new ones go above every persisted id.
    for (const row of this.sql.databases.all([])) {
      for (const store of (JSON.parse(String(row.schema)) as DatabaseSchema).stores) {
        this.nextStoreId = Math.max(this.nextStoreId, store.id + 1);
      }
    }
    // Every database this factory creates or loads belongs to this instance.
    this.factory._databases = new OwnedDatabases(this);
    this.wrapFactory();
  }

  private wrapFactory(): void {
    const factory = this.factory;
    const { open, deleteDatabase, databases } = factory;
    factory.open = (name: string, version?: number) => {
      this.hydrate(String(name));
      return open.call(factory, name, version);
    };
    factory.deleteDatabase = (name: string) => {
      this.hydrate(String(name));
      const request = deleteDatabase.call(factory, name);
      request.addEventListener("success", () => this.forget(String(name)));
      return request;
    };
    factory.databases = () => {
      for (const row of this.sql.databases.all([])) this.hydrate(String(row.name));
      return databases.call(factory);
    };
  }

  private storeId(store: Raw): number {
    let id = this.storeIds.get(store);
    if (id === undefined) this.storeIds.set(store, (id = this.nextStoreId++));
    return id;
  }

  private schemaOf(database: Raw): DatabaseSchema {
    return {
      version: database.version,
      stores: [...database.rawObjectStores.values()].map((store: Raw): StoreSchema => ({
        id: this.storeId(store),
        name: store.name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        keyGenerator: store.keyGenerator?.num ?? null,
        indexes: [...store.rawIndexes.values()].map((index: Raw) => ({
          name: index.name,
          keyPath: index.keyPath,
          unique: index.unique,
          multiEntry: index.multiEntry,
        })),
      })),
    };
  }

  /** Loads a database from SQLite into the factory, unless it is already in memory. */
  hydrate(name: string): void {
    if (this.factory._databases.has(name)) return;
    const row = this.sql.schema.all([name])[0];
    if (!row) return;
    const start = performance.now();
    const { Database, ObjectStore, Index } = this.internals;
    const schema = JSON.parse(String(row.schema)) as DatabaseSchema;
    const database = new Database(name, schema.version);
    const ids = new Set<number>();
    for (const s of schema.stores) {
      const store = new ObjectStore(database, s.name, s.keyPath, s.autoIncrement);
      if (store.keyGenerator && s.keyGenerator !== null) store.keyGenerator.num = s.keyGenerator;
      this.storeIds.set(store, s.id);
      ids.add(s.id);
      for (const record of this.sql.records.all([s.id])) {
        store.records.put({
          key: decodeKey(String(record.key)),
          value: decodeValue(String(record.value)),
        });
        this.stats.hydratedRecords++;
      }
      for (const ix of s.indexes) {
        const index = new Index(store, ix.name, ix.keyPath, ix.multiEntry, ix.unique);
        for (const record of store.records.values()) index.storeRecord(record);
        index.initialized = true;
        store.rawIndexes.set(ix.name, index);
      }
      database.rawObjectStores.set(s.name, store);
    }
    this.persistedStoreIds.set(name, ids);
    this.factory._databases.set(name, database);
    this.stats.hydratedDatabases++;
    this.stats.hydrateMs += performance.now() - start;
  }

  /** The keys a transaction has touched in a store, collected until it commits. */
  track(store: Raw, rollbackLog: unknown[]): Pending {
    let stores = this.pending.get(rollbackLog);
    if (!stores) this.pending.set(rollbackLog, (stores = new Map()));
    let entry = stores.get(store);
    if (!entry) stores.set(store, (entry = { cleared: false, keys: new Map() }));
    return entry;
  }

  /** Writes a committing transaction to SQLite. Throws if SQLite fails; nothing is then written. */
  commit(transaction: Raw): void {
    const database = transaction.db._rawDatabase;
    const changes = this.pending.get(transaction._rollbackLog);
    this.pending.delete(transaction._rollbackLog);
    const versionChange = transaction.mode === "versionchange";
    if (!changes && !versionChange) return;
    const start = performance.now();
    let written = 0;
    let deleted = 0;
    this.sqlite.exec("BEGIN");
    try {
      let schemaChanged = versionChange;
      if (versionChange) {
        const live = new Set<number>(
          [...database.rawObjectStores.values()].map((s: Raw) => this.storeId(s)),
        );
        for (const id of this.persistedStoreIds.get(database.name) ?? []) {
          if (!live.has(id)) this.sql.deleteStore.run([id]);
        }
      }
      for (const [store, entry] of changes ?? []) {
        if (store.deleted) continue;
        const id = this.storeId(store);
        if (entry.cleared) this.sql.deleteStore.run([id]);
        for (const [encoded, key] of entry.keys) {
          const record = store.records.get(key);
          if (record) {
            this.sql.putRecord.run([id, encoded, encodeValue(record.value)]);
            written++;
          } else if (!entry.cleared) {
            this.sql.deleteRecord.run([id, encoded]);
            deleted++;
          }
        }
        if (store.keyGenerator) schemaChanged = true;
      }
      if (schemaChanged)
        this.sql.putSchema.run([database.name, JSON.stringify(this.schemaOf(database))]);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {
        // The original error is the one worth reporting.
      }
      throw error;
    }
    if (versionChange) {
      this.persistedStoreIds.set(
        database.name,
        new Set([...database.rawObjectStores.values()].map((s: Raw) => this.storeId(s))),
      );
    }
    this.stats.commits++;
    this.stats.writtenRecords += written;
    this.stats.deletedRecords += deleted;
    this.stats.commitMs += performance.now() - start;
  }

  commitFailed(error: unknown): void {
    this.stats.failedCommits++;
    this.onCommitError(error);
  }

  private forget(name: string): void {
    this.sqlite.exec("BEGIN");
    try {
      for (const id of this.persistedStoreIds.get(name) ?? []) this.sql.deleteStore.run([id]);
      this.sql.deleteSchema.run([name]);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    this.persistedStoreIds.delete(name);
  }
}

const ownerOfDatabase = new WeakMap<Raw, Persistence>();

/** The factory's name -> database map, which records which instance each database belongs to. */
class OwnedDatabases extends Map<string, Raw> {
  private readonly owner: Persistence;
  constructor(owner: Persistence) {
    super();
    this.owner = owner;
  }
  override set(name: string, database: Raw): this {
    ownerOfDatabase.set(database, this.owner);
    return super.set(name, database);
  }
}
const ABORTING = Symbol("react-native-indexeddb-sqlite.aborting");
let internalsPromise: Promise<Internals> | undefined;

/** Finds fake-indexeddb's internal classes (they are not exported) and installs the hooks, once. */
function hookFakeIndexedDB(): Promise<Internals> {
  internalsPromise ??= (async () => {
    const scratch = new FakeIDBFactory();
    const db: Raw = await new Promise((resolve, reject) => {
      const request = scratch.open("bootstrap", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("s").createIndex("i", "x");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const store: Raw = db.transaction("s").objectStore("s");
    const internals: Internals = {
      Database: db._rawDatabase.constructor,
      ObjectStore: store._rawObjectStore.constructor,
      Index: store.index("i")._rawIndex.constructor,
    };
    db.close();

    // Record which keys each transaction writes. Calls without a rollback log are fake-indexeddb
    // undoing an aborted transaction, which never reaches SQLite.
    const objectStore = internals.ObjectStore.prototype;
    const { storeRecord, deleteRecord, clear } = objectStore;
    objectStore.storeRecord = function (
      this: Raw,
      record: Raw,
      noOverwrite: boolean,
      rollbackLog?: unknown[],
    ) {
      const key = storeRecord.call(this, record, noOverwrite, rollbackLog);
      const owner = rollbackLog && ownerOfDatabase.get(this.rawDatabase);
      if (owner) owner.track(this, rollbackLog).keys.set(encodeKey(key), key);
      return key;
    };
    objectStore.deleteRecord = function (this: Raw, key: unknown, rollbackLog?: unknown[]) {
      const owner = rollbackLog && ownerOfDatabase.get(this.rawDatabase);
      if (owner) {
        const entry = owner.track(this, rollbackLog);
        if (key instanceof FakeIDBKeyRange) {
          for (const record of this.records.values(key))
            entry.keys.set(encodeKey(record.key), record.key);
        } else {
          entry.keys.set(encodeKey(key), key);
        }
      }
      return deleteRecord.call(this, key, rollbackLog);
    };
    objectStore.clear = function (this: Raw, rollbackLog?: unknown[]) {
      const owner = rollbackLog && ownerOfDatabase.get(this.rawDatabase);
      if (owner) {
        const entry = owner.track(this, rollbackLog);
        entry.cleared = true;
        entry.keys.clear();
      }
      return clear.call(this, rollbackLog);
    };

    // A transaction finishes through _markFinished, either from _abort or because it committed.
    // On commit, write it to SQLite first; if that fails, abort it instead.
    const transaction = FakeIDBTransaction.prototype as Raw;
    const { _abort: abort, _markFinished: markFinished } = transaction;
    transaction._abort = function (this: Raw, errorName: string | null) {
      this[ABORTING] = true;
      return abort.call(this, errorName);
    };
    transaction._markFinished = function (this: Raw) {
      const owner = !this[ABORTING] && ownerOfDatabase.get(this.db._rawDatabase);
      if (owner) {
        try {
          owner.commit(this);
        } catch (error) {
          owner.commitFailed(error);
          this._abort("UnknownError"); // rolls back, fires abort, and finishes the transaction
          return;
        }
      }
      return markFinished.call(this);
    };
    return internals;
  })();
  return internalsPromise;
}

/**
 * Creates an IndexedDB factory whose databases persist to `options.sqlite`, and (unless `target`
 * is `null`) defines it as `indexedDB`, with the `IDB*` classes, on `globalThis`. Use one
 * instance per SQLite database file.
 */
export async function installPersistentIndexedDB(
  options: InstallOptions,
): Promise<PersistentIndexedDB> {
  if (typeof structuredClone !== "function") {
    throw new Error(
      "react-native-indexeddb-sqlite: structuredClone is missing. Expo provides it; in bare React Native, install a polyfill such as @ungap/structured-clone.",
    );
  }
  if (!Array.prototype.findLast) {
    // fake-indexeddb uses it; older Hermes versions lack it.
    Object.defineProperty(Array.prototype, "findLast", {
      value<T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown) {
        for (let i = this.length - 1; i >= 0; i--) if (predicate(this[i], i, this)) return this[i];
        return undefined;
      },
      writable: true,
      configurable: true,
    });
  }
  const persistence = new Persistence(options, await hookFakeIndexedDB());
  const target = options.target === undefined ? globalThis : options.target;
  if (target) {
    Object.assign(target, {
      indexedDB: persistence.factory,
      IDBCursor: FakeIDBCursor,
      IDBCursorWithValue: FakeIDBCursorWithValue,
      IDBDatabase: FakeIDBDatabase,
      IDBFactory: FakeIDBFactory,
      IDBIndex: FakeIDBIndex,
      IDBKeyRange: FakeIDBKeyRange,
      IDBObjectStore: FakeIDBObjectStore,
      IDBOpenDBRequest: FakeIDBOpenDBRequest,
      IDBRequest: FakeIDBRequest,
      IDBTransaction: FakeIDBTransaction,
      IDBVersionChangeEvent: FakeIDBVersionChangeEvent,
    });
  }
  return { factory: persistence.factory as IDBFactory, stats: persistence.stats };
}
