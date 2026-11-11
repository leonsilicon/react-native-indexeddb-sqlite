// A persistent IndexedDB for React Native: fake-indexeddb (a spec-compliant, in-memory
// implementation) with a write-through SQLite layer.
//
// - Reads never touch SQLite; fake-indexeddb serves them from memory.
// - When an IndexedDB transaction commits, every record it touched is written to SQLite in one
//   SQLite transaction, before `complete` fires. If that write fails, the IndexedDB transaction
//   aborts instead (memory rolled back, `abort` fired), as a real implementation's would.
// - A database is loaded from SQLite the first time it is opened or deleted, a slice at a time
//   (see `sliceMs`): the open waits for it in fake-indexeddb's connection queue, so nothing
//   sees a half-loaded database and the JavaScript thread stays free meanwhile. Records go
//   straight into a balanced tree in key order. Indexes are not stored: a unique one is built
//   during the load (it has to reject duplicates), the others in the background after it, and
//   any that is read before then is built right away.
// - fake-indexeddb's tasks run on a scheduler that lets the event loop turn every `sliceMs`
//   (scheduler.ts), and values are copied with fast paths for JSON-like data (clone.ts). Both
//   need fake-indexeddb's two hooks (patches/fake-indexeddb@6.2.7.patch); without them it
//   schedules and clones as it always did.
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

import { fastClone, forgetStoredJson, takeStoredJson } from "./clone.ts";
import { decodeKey, decodeValue, encodeKey, encodeRecordValue } from "./encoding.ts";
import { createTaskScheduler, type TaskScheduler, type TaskSchedulerStats } from "./scheduler.ts";

export { fastClone } from "./clone.ts";
export { decodeKey, decodeValue, encodeKey, encodeRecordValue, encodeValue } from "./encoding.ts";
export {
  createTaskScheduler,
  type TaskScheduler,
  type TaskSchedulerOptions,
  type TaskSchedulerStats,
} from "./scheduler.ts";

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
  /** Databases loaded from SQLite, records loaded, and the JavaScript time it took. */
  hydratedDatabases: number;
  hydratedRecords: number;
  hydrateMs: number;
  /** Indexes built from their records since this instance started, and the time that took. */
  indexBuilds: number;
  indexBuildMs: number;
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
  /** Called when loading a database from SQLite fails (opening it then fails). */
  onLoadError?: (name: string, error: unknown) => void;
  /**
   * How long IndexedDB work may hold the JavaScript thread before the event loop gets a turn:
   * fake-indexeddb's tasks, loading a database, building an index. Default 8 ms. `false` keeps
   * fake-indexeddb's own scheduling (`setImmediate`, a microtask on React Native) and loads
   * each database in one go.
   */
  sliceMs?: number | false;
  /** Copy values with the fast paths in clone.ts rather than `structuredClone`. Default true. */
  fastClone?: boolean;
}

export interface PersistentIndexedDB {
  factory: IDBFactory;
  stats: PersistenceStats;
  /** What the slicing scheduler did, or null when fake-indexeddb isn't patched to use it. */
  scheduler: TaskSchedulerStats | null;
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

const QUEUE_TASK_HOOK = Symbol.for("fake-indexeddb.queueTask");
const CLONE_HOOK = Symbol.for("fake-indexeddb.structuredClone");
// How many times an object store has changed: a background index build checks it to know that
// the records it has read are still the store's.
const WRITES = Symbol("react-native-indexeddb-sqlite.writes");
// Rows read from SQLite at a time while loading.
const PAGE_ROWS = 256;

// What `compareKeys` falls back on for the key types it has no shortcut for.
const keyOrder = new FakeIDBFactory();

/**
 * Orders two valid IndexedDB keys the way `indexedDB.cmp` does. Loading calls this for every
 * record, and strings and numbers (most keys) don't need the type checks `cmp` makes.
 */
function compareKeys(a: unknown, b: unknown): number {
  if (
    (typeof a === "string" && typeof b === "string") ||
    (typeof a === "number" && typeof b === "number")
  ) {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) {
      const order = compareKeys(a[i], b[i]);
      if (order !== 0) return order;
    }
    return a.length - b.length;
  }
  return keyOrder.cmp(a, b);
}

const compareRecords = (a: Raw, b: Raw): number => compareKeys(a.key, b.key);
const compareIndexEntries = (a: Raw, b: Raw): number =>
  compareKeys(a.key, b.key) || compareKeys(a.value, b.value);

function writesOf(store: Raw): number {
  return (store[WRITES] as number | undefined) ?? 0;
}

/**
 * Measures JavaScript time in slices: `due()` says when a slice has used its budget (checking
 * the clock every so many calls), and `yield()` gives the event loop a turn (a `setTimeout`)
 * and starts the next slice.
 */
class Slicer {
  busyMs = 0;
  private start = performance.now();
  private calls = 0;
  private readonly budget: number;
  constructor(budget: number) {
    this.budget = budget;
  }
  over(): boolean {
    return performance.now() - this.start >= this.budget;
  }
  due(every = 64): boolean {
    return ++this.calls % every === 0 && this.over();
  }
  async yield(): Promise<void> {
    this.busyMs += performance.now() - this.start;
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.start = performance.now();
  }
  stop(): number {
    this.busyMs += performance.now() - this.start;
    this.start = performance.now();
    return this.busyMs;
  }
}

/**
 * Sorts `items` in slices (a merge sort of short sorted runs), checking `stillWanted` after each
 * yield. Returns `items` itself when it is already sorted, and null if it stopped because the
 * result was no longer wanted.
 */
async function sortInSlices<T>(
  items: T[],
  compare: (a: T, b: T) => number,
  slicer: Slicer,
  stillWanted: () => boolean = () => true,
): Promise<T[] | null> {
  let sorted = true;
  for (let i = 1; i < items.length; i++) {
    if (compare(items[i - 1]!, items[i]!) > 0) {
      sorted = false;
      break;
    }
    if (slicer.due(1024)) {
      await slicer.yield();
      if (!stillWanted()) return null;
    }
  }
  if (sorted) return items;
  const RUN = 256;
  let from = items.slice();
  for (let start = 0; start < from.length; start += RUN) {
    const run = from.slice(start, start + RUN).sort(compare);
    for (let i = 0; i < run.length; i++) from[start + i] = run[i]!;
    if (slicer.due(1)) {
      await slicer.yield();
      if (!stillWanted()) return null;
    }
  }
  let to = from.slice();
  for (let width = RUN; width < from.length; width *= 2) {
    for (let left = 0; left < from.length; left += 2 * width) {
      const mid = Math.min(left + width, from.length);
      const end = Math.min(left + 2 * width, from.length);
      let i = left;
      let j = mid;
      let k = left;
      while (i < mid && j < end) {
        to[k++] = compare(from[i]!, from[j]!) <= 0 ? from[i++]! : from[j++]!;
        if (slicer.due(1024)) {
          await slicer.yield();
          if (!stillWanted()) return null;
        }
      }
      while (i < mid) to[k++] = from[i++]!;
      while (j < end) to[k++] = from[j++]!;
    }
    [from, to] = [to, from];
  }
  return from;
}

/**
 * Replaces the contents of a fake-indexeddb RecordStore with `records`, already in order, an
 * order of magnitude faster than putting them one by one: no tree walk or rebalancing per record.
 */
function bulkLoad(recordStore: Raw, records: Raw[]): void {
  const tree = recordStore.records;
  tree._root = tree._rebuild(records, undefined, false);
  tree._numNodes = records.length;
  tree._numTombstones = 0;
}

/** The entries an index has for one record of its store. */
function addIndexEntries(index: Raw, record: Raw, entries: Raw[]): void {
  const indexKey = index.getIndexKey(record.value);
  if (indexKey === undefined) return;
  if (index.multiEntry && Array.isArray(indexKey)) {
    for (const key of indexKey) entries.push({ key, value: record.key });
  } else {
    entries.push({ key: indexKey, value: record.key });
  }
}

function prepareStatements(sqlite: SyncSqlite) {
  const prepare = (sql: string) => sqlite.prepare(sql);
  return {
    databases: prepare("SELECT name, schema FROM idb_database"),
    schema: prepare("SELECT schema FROM idb_database WHERE name = ?"),
    putSchema: prepare("INSERT OR REPLACE INTO idb_database (name, schema) VALUES (?, ?)"),
    deleteSchema: prepare("DELETE FROM idb_database WHERE name = ?"),
    // A page at a time, in primary key order, so that a store whose keys sort the same way as
    // IndexedDB's needs no sorting in JavaScript. Every encoded key is longer than ''.
    records: prepare(
      "SELECT key, value, blob FROM idb_record WHERE store = ? AND key > ? ORDER BY key LIMIT ?",
    ),
    putRecord: prepare(
      "INSERT OR REPLACE INTO idb_record (store, key, value, blob) VALUES (?, ?, ?, ?)",
    ),
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
    indexBuilds: 0,
    indexBuildMs: 0,
    commits: 0,
    writtenRecords: 0,
    deletedRecords: 0,
    commitMs: 0,
    failedCommits: 0,
  };
  private readonly sqlite: SyncSqlite;
  private readonly internals: Internals;
  private readonly onCommitError: (error: unknown) => void;
  private readonly onLoadError: (name: string, error: unknown) => void;
  private readonly sliceMs: number;
  private readonly sql: ReturnType<typeof prepareStatements>;
  private readonly storeIds = new WeakMap<Raw, number>();
  private readonly persistedStoreIds = new Map<string, Set<number>>();
  private readonly pending = new WeakMap<unknown[], Map<Raw, Pending>>();
  private readonly loading = new Map<string, Promise<void>>();
  // Loaded indexes not built yet, and what settles each one with its built tree.
  private readonly deferredIndexes = new Map<Raw, () => Raw>();
  private backgroundBuilds: Promise<void> = Promise.resolve();
  private nextStoreId = 1;

  constructor(options: InstallOptions, internals: Internals) {
    this.sqlite = options.sqlite;
    this.internals = internals;
    this.sliceMs = options.sliceMs === false ? Infinity : (options.sliceMs ?? 8);
    this.onCommitError =
      options.onCommitError ??
      ((error) => console.error("react-native-indexeddb-sqlite: commit failed", error));
    this.onLoadError =
      options.onLoadError ??
      ((name, error) =>
        console.error(`react-native-indexeddb-sqlite: loading ${name} failed`, error));
    this.sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = ${options.synchronous === "FULL" ? "FULL" : "NORMAL"};
      CREATE TABLE IF NOT EXISTS idb_database (name TEXT PRIMARY KEY, schema TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idb_record (
        store INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, blob BLOB,
        PRIMARY KEY (store, key)
      ) WITHOUT ROWID;
    `);
    // Files written before binary data went in a BLOB have no column for it.
    const columns = this.sqlite.prepare("PRAGMA table_info(idb_record)").all([]);
    if (!columns.some((column) => column.name === "blob")) {
      this.sqlite.exec("ALTER TABLE idb_record ADD COLUMN blob BLOB");
    }
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
    factory.open = (...args: [name: string, version?: number]) => {
      this.loadBeforeConnecting(String(args[0]));
      return open.apply(factory, args);
    };
    factory.deleteDatabase = (...args: [name: string]) => {
      const name = String(args[0]);
      this.loadBeforeConnecting(name);
      const request = deleteDatabase.apply(factory, args);
      request.addEventListener("success", () => this.forget(name));
      return request;
    };
    // What is in memory, and what is only on disk (at the version it was saved with).
    factory.databases = async () => {
      const listed: IDBDatabaseInfo[] = await databases.call(factory);
      const names = new Set(listed.map((info) => info.name));
      for (const row of this.sql.databases.all([])) {
        const name = String(row.name);
        if (names.has(name) || factory._databases.has(name)) continue;
        listed.push({ name, version: (JSON.parse(String(row.schema)) as DatabaseSchema).version });
      }
      return listed;
    };
  }

  /**
   * Makes the next connection request for `name` (an open or delete, which fake-indexeddb runs
   * one at a time per name through its connection queue) wait for the database to be loaded.
   */
  private loadBeforeConnecting(name: string): void {
    if (this.factory._databases.has(name)) return;
    const queues: Map<string, Promise<void>> = this.factory._connectionQueues;
    const before = queues.get(name) ?? Promise.resolve();
    queues.set(
      name,
      before.then(() => this.load(name)),
    );
  }

  /** Loads a database from SQLite into the factory, unless it is in memory already. */
  load(name: string): Promise<void> {
    if (this.factory._databases.has(name)) return Promise.resolve();
    let loading = this.loading.get(name);
    if (!loading) {
      loading = this.loadInSlices(name)
        .catch((error: unknown) => {
          this.onLoadError(name, error);
          this.registerUnreadable(name);
        })
        .finally(() => this.loading.delete(name));
      this.loading.set(name, loading);
    }
    return loading;
  }

  private async loadInSlices(name: string): Promise<void> {
    const row = this.sql.schema.all([name])[0];
    if (!row) return;
    const slicer = new Slicer(this.sliceMs);
    const { Database, ObjectStore, Index } = this.internals;
    const schema = JSON.parse(String(row.schema)) as DatabaseSchema;
    const database = new Database(name, schema.version);
    const ids = new Set<number>();
    const deferred: [index: Raw, store: Raw][] = [];
    let loaded = 0;
    for (const s of schema.stores) {
      const store = new ObjectStore(database, s.name, s.keyPath, s.autoIncrement);
      if (store.keyGenerator && s.keyGenerator !== null) store.keyGenerator.num = s.keyGenerator;
      this.storeIds.set(store, s.id);
      ids.add(s.id);
      const records: Raw[] = [];
      let after = "";
      for (;;) {
        const rows = this.sql.records.all([s.id, after, PAGE_ROWS]);
        for (const r of rows) {
          records.push({
            key: decodeKey(String(r.key)),
            value: decodeValue(String(r.value), (r.blob as Uint8Array | null) ?? null),
          });
          if (slicer.due(16)) await slicer.yield();
        }
        if (rows.length < PAGE_ROWS) break;
        after = String(rows[rows.length - 1]!.key);
        if (slicer.over()) await slicer.yield();
      }
      // SQLite's order is the right one for most keys but not all (2 sorts after 10 as text).
      bulkLoad(store.records, (await sortInSlices(records, compareRecords, slicer))!);
      loaded += records.length;
      for (const ix of s.indexes) {
        const index = new Index(store, ix.name, ix.keyPath, ix.multiEntry, ix.unique);
        // A unique index has to exist to reject a duplicate, so it is built now.
        if (ix.unique) await this.buildIndexInSlices(index, store, slicer);
        else {
          this.deferIndex(index, store);
          deferred.push([index, store]);
        }
        index.initialized = true;
        store.rawIndexes.set(ix.name, index);
      }
      database.rawObjectStores.set(s.name, store);
      if (slicer.over()) await slicer.yield();
    }
    // Nothing could touch the database while it loaded: it wasn't in the factory, and every
    // open or delete of it waited for this.
    this.persistedStoreIds.set(name, ids);
    this.factory._databases.set(name, database);
    this.stats.hydratedDatabases++;
    this.stats.hydratedRecords += loaded;
    this.stats.hydrateMs += slicer.stop();
    for (const [index, store] of deferred) this.buildInBackground(index, store);
  }

  /**
   * After a load that failed, a database nobody can upgrade or write to (so nothing replaces
   * what is on disk), until it is deleted.
   */
  private registerUnreadable(name: string): void {
    if (this.factory._databases.has(name)) return;
    const ids = new Set<number>();
    try {
      const row = this.sql.schema.all([name])[0];
      if (row)
        for (const s of (JSON.parse(String(row.schema)) as DatabaseSchema).stores) ids.add(s.id);
    } catch {
      // The schema itself is unreadable; deleting the database still removes the schema row.
    }
    this.persistedStoreIds.set(name, ids);
    this.factory._databases.set(name, new this.internals.Database(name, Number.MAX_SAFE_INTEGER));
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

  /** Fills an index from the current records of its store, in one go. */
  private buildIndex(index: Raw, store: Raw): void {
    const start = performance.now();
    const entries: Raw[] = [];
    for (const record of store.records.values()) addIndexEntries(index, record, entries);
    entries.sort(index.unique ? compareRecords : compareIndexEntries);
    bulkLoad(index.records, entries);
    this.stats.indexBuilds++;
    this.stats.indexBuildMs += performance.now() - start;
  }

  /** Fills an index from the records of its store while it loads (nothing else can write them). */
  private async buildIndexInSlices(index: Raw, store: Raw, slicer: Slicer): Promise<void> {
    const before = slicer.stop();
    const entries: Raw[] = [];
    for (const record of store.records.values()) {
      addIndexEntries(index, record, entries);
      if (slicer.due()) await slicer.yield();
    }
    const compare = index.unique ? compareRecords : compareIndexEntries;
    bulkLoad(index.records, (await sortInSlices(entries, compare, slicer))!);
    this.stats.indexBuilds++;
    this.stats.indexBuildMs += slicer.stop() - before;
  }

  /**
   * Leaves a loaded index empty until it is built in the background, or read, whichever comes
   * first. Writes before then are dropped, not lost: a build reads the store's current records,
   * which include them (and a rollback has undone them in the store by then, or will undo them
   * through the built index).
   */
  private deferIndex(index: Raw, store: Raw): void {
    const records = index.records;
    const settle = (value: Raw = records): Raw => {
      this.deferredIndexes.delete(index);
      delete index.storeRecord;
      delete index.deleteRecord;
      Object.defineProperty(index, "records", {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return value;
    };
    this.deferredIndexes.set(index, settle);
    index.storeRecord = () => undefined;
    index.deleteRecord = () => undefined;
    Object.defineProperty(index, "records", {
      enumerable: true,
      configurable: true,
      get: () => {
        settle();
        this.buildIndex(index, store);
        return records;
      },
      set: settle,
    });
  }

  /**
   * Builds a deferred index a slice at a time, one index after another, starting from a fresh
   * turn of the event loop. If the store changes while it reads the records, it starts again,
   * after a pause that grows each time; if the store keeps changing, or the index is read
   * first, the first read builds it.
   */
  private buildInBackground(index: Raw, store: Raw): void {
    this.backgroundBuilds = this.backgroundBuilds.then(async () => {
      const slicer = new Slicer(this.sliceMs);
      await slicer.yield();
      slicer.stop();
      const settle = (): (() => Raw) | undefined => this.deferredIndexes.get(index);
      const compare = index.unique ? compareRecords : compareIndexEntries;
      const before = slicer.busyMs;
      attempts: for (let attempt = 0; attempt < 10; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 2000)));
          slicer.stop();
        }
        if (!settle()) return;
        const writes = writesOf(store);
        const unchanged = (): boolean => settle() !== undefined && writesOf(store) === writes;
        const entries: Raw[] = [];
        for (const record of store.records.values()) {
          addIndexEntries(index, record, entries);
          if (slicer.due()) {
            await slicer.yield();
            if (!unchanged()) continue attempts;
          }
        }
        const sorted = await sortInSlices(entries, compare, slicer, unchanged);
        if (!sorted || !unchanged()) continue;
        const records = settle()!();
        bulkLoad(records, sorted);
        this.stats.indexBuilds++;
        this.stats.indexBuildMs += slicer.stop() - before;
        return;
      }
    });
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
            const [text, blob] = encodeRecordValue(record.value, takeStoredJson(record.value));
            this.sql.putRecord.run([id, encoded, text, blob]);
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
// One scheduler for every instance: fake-indexeddb's tasks are global, and their order matters.
let scheduler: TaskScheduler | undefined;
let schedulerHonored = false;

/**
 * Installs the slicing scheduler as fake-indexeddb's `queueTask` (a no-op if the patch that
 * reads it is missing) with the given budget.
 */
function installScheduler(sliceMs: number | false): void {
  const hooks = globalThis as Record<symbol, unknown>;
  if (sliceMs === false) {
    delete hooks[QUEUE_TASK_HOOK];
    return;
  }
  scheduler ??= createTaskScheduler();
  scheduler.budgetMs = sliceMs;
  hooks[QUEUE_TASK_HOOK] = scheduler.queueTask;
}

function bump(store: Raw): void {
  store[WRITES] = writesOf(store) + 1;
}

/** Finds fake-indexeddb's internal classes (they are not exported) and installs the hooks, once. */
function hookFakeIndexedDB(): Promise<Internals> {
  internalsPromise ??= (async () => {
    const tasksBefore = scheduler?.stats.tasks ?? 0;
    const scratch = new FakeIDBFactory();
    const db: Raw = await new Promise((resolve, reject) => {
      const request = scratch.open("bootstrap", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("s").createIndex("i", "x");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    schedulerHonored = (scheduler?.stats.tasks ?? 0) > tasksBefore;
    const store: Raw = db.transaction("s").objectStore("s");
    const internals: Internals = {
      Database: db._rawDatabase.constructor,
      ObjectStore: store._rawObjectStore.constructor,
      Index: store.index("i")._rawIndex.constructor,
    };
    db.close();

    // Record which keys each transaction writes. Calls without a rollback log are fake-indexeddb
    // undoing an aborted transaction, which never reaches SQLite. Every call counts as a change
    // of the store, for background index builds.
    const objectStore = internals.ObjectStore.prototype;
    const { storeRecord, deleteRecord, clear } = objectStore;
    objectStore.storeRecord = function (
      this: Raw,
      record: Raw,
      noOverwrite: boolean,
      rollbackLog?: unknown[],
    ) {
      bump(this);
      const key = storeRecord.call(this, record, noOverwrite, rollbackLog);
      // A generated key may have been written into the value after it was copied.
      if (this.keyGenerator !== null && this.keyPath !== null) forgetStoredJson(record.value);
      const owner = rollbackLog && ownerOfDatabase.get(this.rawDatabase);
      if (owner) owner.track(this, rollbackLog).keys.set(encodeKey(key), key);
      return key;
    };
    objectStore.deleteRecord = function (this: Raw, key: unknown, rollbackLog?: unknown[]) {
      bump(this);
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
      bump(this);
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
  const hooks = globalThis as Record<symbol, unknown>;
  if (options.fastClone === false) delete hooks[CLONE_HOOK];
  else hooks[CLONE_HOOK] = fastClone;
  installScheduler(options.sliceMs ?? 8);
  const persistence = new Persistence(options, await hookFakeIndexedDB());
  if (!schedulerHonored && options.sliceMs !== false) {
    console.warn(
      "react-native-indexeddb-sqlite: fake-indexeddb isn't patched (patches/fake-indexeddb@6.2.7.patch), so its tasks don't yield to the event loop.",
    );
  }
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
  return {
    factory: persistence.factory as IDBFactory,
    stats: persistence.stats,
    scheduler: schedulerHonored && options.sliceMs !== false ? scheduler!.stats : null,
  };
}
