// Loading a database a slice at a time, building its indexes in the background, and keeping
// binary data in BLOBs.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { IDBKeyRange as FakeIDBKeyRange } from "fake-indexeddb";

import { done, entries, open, request, start, tempDatabaseFile } from "./helpers.ts";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Counts the event loop's turns until `stop()` is called. */
function countTurns(): { stop: () => number } {
  let turns = 0;
  let running = true;
  const tick = () => {
    if (!running) return;
    turns++;
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return {
    stop: () => {
      running = false;
      return turns;
    },
  };
}

async function fill(file: string, count: number): Promise<void> {
  const { factory } = await start(file);
  const db = await open(factory, "app", 1, (db) => {
    const store = db.createObjectStore("s");
    store.createIndex("byScore", "score");
    store.createIndex("byTag", "tags", { multiEntry: true });
    store.createIndex("byId", "id", { unique: true });
  });
  const tx = db.transaction("s", "readwrite");
  for (let i = 0; i < count; i++) {
    tx.objectStore("s").put(
      { id: `id${i}`, score: i % 97, tags: [`t${i % 5}`, `u${i % 3}`], text: "x".repeat(100) },
      i,
    );
  }
  await done(tx);
  db.close();
}

test("binary data is stored as a BLOB, and survives a restart", async () => {
  const file = tempDatabaseFile();
  const bytes = new Uint8Array(10_000).map((_, i) => i % 251);
  {
    const { factory } = await start(file);
    const db = await open(factory, "app", 1, (db) => void db.createObjectStore("s"));
    const tx = db.transaction("s", "readwrite");
    tx.objectStore("s").put({ name: "bank", data: bytes.buffer, view: bytes.subarray(5, 9) }, "k");
    await done(tx);
  }
  const row = new DatabaseSync(file)
    .prepare("SELECT value, blob FROM idb_record WHERE key = 'sk'")
    .get() as { value: string; blob: Uint8Array };
  assert.ok(row.value.length < 200, `no base64 in the text: ${row.value}`);
  assert.equal(row.blob.byteLength, 10_004);

  const { factory } = await start(file);
  const db = await open(factory, "app");
  const value = (await request(db.transaction("s").objectStore("s").get("k"))) as {
    data: ArrayBuffer;
    view: Uint8Array;
  };
  assert.deepEqual(new Uint8Array(value.data), bytes);
  assert.deepEqual([...value.view], [5, 6, 7, 8]);
});

test("records written before BLOBs (base64 in the text) still load, and the column is added", async () => {
  const file = tempDatabaseFile();
  const sqlite = new DatabaseSync(file);
  sqlite.exec(`
    CREATE TABLE idb_database (name TEXT PRIMARY KEY, schema TEXT NOT NULL);
    CREATE TABLE idb_record (
      store INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (store, key)
    ) WITHOUT ROWID;
  `);
  sqlite.prepare("INSERT INTO idb_database VALUES (?, ?)").run(
    "app",
    JSON.stringify({
      version: 1,
      stores: [
        { id: 1, name: "s", keyPath: null, autoIncrement: false, keyGenerator: null, indexes: [] },
      ],
    }),
  );
  sqlite
    .prepare("INSERT INTO idb_record VALUES (1, 'sk', ?)")
    .run('T{"$":"tv","c":"Uint8Array","v":"AQID"}');
  sqlite.close();

  const { factory } = await start(file);
  const db = await open(factory, "app");
  assert.deepEqual(
    await request(db.transaction("s").objectStore("s").get("k")),
    new Uint8Array([1, 2, 3]),
  );
  const columns = new DatabaseSync(file).prepare("PRAGMA table_info(idb_record)").all();
  assert.ok(columns.some((column) => column.name === "blob"));
});

test("a database loads a slice at a time, and the event loop turns meanwhile", async () => {
  const file = tempDatabaseFile();
  await fill(file, 3000);
  const { factory, stats } = await start(file, { sliceMs: 1 });
  const turns = countTurns();
  const db = await open(factory, "app");
  const turned = turns.stop();
  assert.ok(turned > 0, `turns during the load: ${turned}`);
  assert.equal(stats.hydratedRecords, 3000);
  const store = db.transaction("s").objectStore("s");
  assert.equal(await request(store.count()), 3000);
  assert.deepEqual(await request(store.get(1234)), {
    id: "id1234",
    score: 1234 % 97,
    tags: ["t4", "u1"],
    text: "x".repeat(100),
  });
  // The unique index was built during the load and is enforced.
  const write = db.transaction("s", "readwrite");
  await assert.rejects(request(write.objectStore("s").add({ id: "id7" }, "dup")), {
    name: "ConstraintError",
  });
});

test("opens and deletes made during a load wait for it, in order", async () => {
  const file = tempDatabaseFile();
  await fill(file, 500);
  const { factory, stats } = await start(file, { sliceMs: 0 });
  const first = open(factory, "app");
  const second = open(factory, "app");
  const [a, b] = await Promise.all([first, second]);
  assert.equal(stats.hydratedDatabases, 1, "loaded once");
  assert.equal(await request(a.transaction("s").objectStore("s").count()), 500);
  a.close();
  b.close();
  await request(factory.deleteDatabase("app"));
  const restarted = await start(file);
  assert.deepEqual(await restarted.factory.databases(), []);
});

test("databases() lists what is on disk without loading it", async () => {
  const file = tempDatabaseFile();
  await fill(file, 10);
  const { factory, stats } = await start(file);
  assert.deepEqual(await factory.databases(), [{ name: "app", version: 1 }]);
  assert.equal(stats.hydratedDatabases, 0);
});

test("non-unique indexes are built in the background after a load, a slice at a time", async () => {
  const file = tempDatabaseFile();
  await fill(file, 3000);
  const { factory, stats } = await start(file, { sliceMs: 1 });
  const db = await open(factory, "app");
  assert.equal(stats.indexBuilds, 1, "only the unique index during the load");
  for (let i = 0; i < 500 && stats.indexBuilds < 3; i++) await turn();
  assert.equal(stats.indexBuilds, 3);
  const index = db.transaction("s").objectStore("s").index("byScore");
  const keys = (await request(index.getAllKeys(FakeIDBKeyRange.only(5)))) as number[];
  assert.deepEqual(
    keys,
    Array.from({ length: 3000 }, (_, i) => i).filter((i) => i % 97 === 5),
  );
  assert.equal(stats.indexBuilds, 3, "reading it built nothing more");
});

test("writes during a background index build make it start again, and end up in the index", async () => {
  const file = tempDatabaseFile();
  await fill(file, 1000);
  const { factory, stats } = await start(file, { sliceMs: 0 });
  const db = await open(factory, "app");
  // Write while the builds run, one write per turn of the event loop.
  for (let i = 0; i < 20; i++) {
    const tx = db.transaction("s", "readwrite");
    tx.objectStore("s").put({ id: `new${i}`, score: 1000, tags: ["fresh"] }, 10_000 + i);
    tx.objectStore("s").delete(i);
    await done(tx);
    await turn();
  }
  // Once the writes stop, the builds that started over finish on their own.
  for (let i = 0; i < 400 && stats.indexBuilds < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(stats.indexBuilds, 3);
  const store = db.transaction("s").objectStore("s");
  assert.deepEqual(
    await request(store.index("byScore").getAllKeys(FakeIDBKeyRange.only(1000))),
    Array.from({ length: 20 }, (_, i) => 10_000 + i),
  );
  const fresh = await entries(store.index("byTag"), FakeIDBKeyRange.only("fresh"));
  assert.equal(fresh.length, 20);
  const zero = (await request(
    store.index("byScore").getAllKeys(FakeIDBKeyRange.only(0)),
  )) as number[];
  assert.ok(!zero.includes(0), "a deleted record left the index");
  assert.equal(zero.length, Math.ceil(1000 / 97) - 1);
});

test("a database that fails to load can't be opened or overwritten, and its data stays on disk", async () => {
  const file = tempDatabaseFile();
  await fill(file, 10);
  const sqlite = new DatabaseSync(file);
  sqlite.prepare("UPDATE idb_record SET value = 'J{broken' WHERE key = 'n3'").run();
  const errors: unknown[] = [];
  const { factory } = await start(file, { onLoadError: (_, error) => errors.push(error) });
  await assert.rejects(open(factory, "app", 2), { name: "VersionError" });
  assert.equal(errors.length, 1);
  const rows = sqlite.prepare("SELECT count(*) AS n FROM idb_record").get() as { n: number };
  assert.equal(rows.n, 10);
});
