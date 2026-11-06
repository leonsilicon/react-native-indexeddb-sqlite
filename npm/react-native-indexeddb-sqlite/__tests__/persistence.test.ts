import assert from "node:assert/strict";
import { test } from "node:test";

import { IDBKeyRange as FakeIDBKeyRange } from "fake-indexeddb";

import { done, entries, open, request, start, tempDatabaseFile } from "./helpers.ts";

test("records, indexes and key generators survive a restart", async () => {
  const file = tempDatabaseFile();
  {
    const { factory } = await start(file);
    const db = await open(factory, "app", 1, (db) => {
      db.createObjectStore("plain");
      const notes = db.createObjectStore("notes", { keyPath: "id", autoIncrement: true });
      notes.createIndex("byTag", "tags", { multiEntry: true });
      notes.createIndex("bySlug", "slug", { unique: true });
    });
    const tx = db.transaction(["plain", "notes"], "readwrite");
    const plain = tx.objectStore("plain");
    plain.put(
      { bytes: new Uint8Array([1, 2, 3]), when: new Date(5), map: new Map([["k", 1n]]) },
      "binary",
    );
    plain.put("by date", new Date(1000));
    plain.put("by array", ["a", 1]);
    plain.put("by buffer", new Uint8Array([9, 9]).buffer);
    const notes = tx.objectStore("notes");
    notes.add({ slug: "first", tags: ["a", "b"] });
    notes.add({ slug: "second", tags: ["b"] });
    await done(tx);
    db.close();
  }

  const { factory, stats } = await start(file);
  const db = await open(factory, "app");
  assert.equal(stats.hydratedDatabases, 1);
  assert.equal(db.version, 1);
  assert.deepEqual([...db.objectStoreNames], ["notes", "plain"]);

  const tx = db.transaction(["plain", "notes"], "readwrite");
  const binary = (await request(tx.objectStore("plain").get("binary"))) as Record<string, unknown>;
  assert.deepEqual(binary.bytes, new Uint8Array([1, 2, 3]));
  assert.deepEqual(binary.when, new Date(5));
  assert.deepEqual(binary.map, new Map([["k", 1n]]));
  assert.equal(await request(tx.objectStore("plain").get(new Date(1000))), "by date");
  assert.equal(await request(tx.objectStore("plain").get(["a", 1])), "by array");
  assert.equal(
    await request(tx.objectStore("plain").get(new Uint8Array([9, 9]).buffer)),
    "by buffer",
  );

  const notes = tx.objectStore("notes");
  assert.deepEqual(
    (await entries(notes.index("byTag"), FakeIDBKeyRange.only("b"))).map(
      ([, v]) => (v as { slug: string }).slug,
    ),
    ["first", "second"],
  );
  assert.equal(((await request(notes.index("bySlug").get("second"))) as { id: number }).id, 2);
  // The key generator carries on from where it was, and unique indexes are still enforced.
  assert.equal(await request(notes.add({ slug: "third", tags: [] })), 3);
  await assert.rejects(request(notes.add({ slug: "first", tags: [] })), {
    name: "ConstraintError",
  });
});

test("an aborted transaction leaves nothing on disk", async () => {
  const file = tempDatabaseFile();
  {
    const { factory } = await start(file);
    const db = await open(factory, "app", 1, (db) => void db.createObjectStore("s"));
    const kept = db.transaction("s", "readwrite");
    kept.objectStore("s").put("kept", "a");
    await done(kept);
    const aborted = db.transaction("s", "readwrite");
    aborted.objectStore("s").put("lost", "b");
    aborted.objectStore("s").delete("a");
    aborted.abort();
    await assert.rejects(done(aborted));
  }
  const { factory } = await start(file);
  const db = await open(factory, "app");
  assert.deepEqual(await entries(db.transaction("s").objectStore("s")), [["a", "kept"]]);
});

test("deletes, range deletes and clear are persisted", async () => {
  const file = tempDatabaseFile();
  {
    const { factory } = await start(file);
    const db = await open(factory, "app", 1, (db) => {
      db.createObjectStore("a");
      db.createObjectStore("b");
    });
    const fill = db.transaction(["a", "b"], "readwrite");
    for (let i = 0; i < 10; i++) {
      fill.objectStore("a").put(i, i);
      fill.objectStore("b").put(i, i);
    }
    await done(fill);
    const change = db.transaction(["a", "b"], "readwrite");
    change.objectStore("a").delete(0);
    change.objectStore("a").delete(FakeIDBKeyRange.bound(5, 8));
    change.objectStore("b").clear();
    change.objectStore("b").put("after clear", 42);
    await done(change);
  }
  const { factory } = await start(file);
  const db = await open(factory, "app");
  const tx = db.transaction(["a", "b"]);
  assert.deepEqual(
    (await entries(tx.objectStore("a"))).map(([k]) => k),
    [1, 2, 3, 4, 9],
  );
  assert.deepEqual(await entries(tx.objectStore("b")), [[42, "after clear"]]);
});

test("upgrades: renamed, deleted and new stores and indexes are persisted", async () => {
  const file = tempDatabaseFile();
  {
    const { factory } = await start(file);
    const db = await open(factory, "app", 1, (db) => {
      db.createObjectStore("old").createIndex("byX", "x");
      db.createObjectStore("doomed");
    });
    const tx = db.transaction(["old", "doomed"], "readwrite");
    tx.objectStore("old").put({ x: 1, y: "one" }, "k1");
    tx.objectStore("doomed").put("gone", "k");
    await done(tx);
    db.close();
  }
  {
    const { factory } = await start(file);
    const db = await open(factory, "app", 2, (db, transaction, oldVersion) => {
      assert.equal(oldVersion, 1);
      const renamed = transaction.objectStore("old");
      renamed.name = "renamed";
      renamed.deleteIndex("byX");
      renamed.createIndex("byY", "y");
      db.deleteObjectStore("doomed");
      db.createObjectStore("fresh").put("new", "k");
    });
    db.close();
  }
  const { factory } = await start(file);
  const db = await open(factory, "app");
  assert.equal(db.version, 2);
  assert.deepEqual([...db.objectStoreNames], ["fresh", "renamed"]);
  const tx = db.transaction(["renamed", "fresh"]);
  const renamed = tx.objectStore("renamed");
  assert.deepEqual([...renamed.indexNames], ["byY"]);
  assert.deepEqual(await request(renamed.index("byY").get("one")), { x: 1, y: "one" });
  assert.equal(await request(tx.objectStore("fresh").get("k")), "new");
});

test("deleteDatabase removes the data, and databases() lists what is on disk", async () => {
  const file = tempDatabaseFile();
  {
    const { factory } = await start(file);
    for (const name of ["keep", "drop"]) {
      const db = await open(
        factory,
        name,
        3,
        (db) => void db.createObjectStore("s").put(name, "k"),
      );
      db.close();
    }
  }
  {
    const { factory } = await start(file);
    assert.deepEqual(
      (await factory.databases())
        .map(({ name, version }) => [name, version])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
      [
        ["drop", 3],
        ["keep", 3],
      ],
    );
    await request(factory.deleteDatabase("drop"));
  }
  const { factory } = await start(file);
  assert.deepEqual(
    (await factory.databases()).map(({ name }) => name),
    ["keep"],
  );
  const db = await open(factory, "drop", 1, (_, __, oldVersion) => assert.equal(oldVersion, 0));
  assert.equal(db.objectStoreNames.length, 0);
});
