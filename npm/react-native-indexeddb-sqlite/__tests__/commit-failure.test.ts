import assert from "node:assert/strict";
import { test } from "node:test";

import type { SyncSqlite } from "../src/index.ts";
import { done, open, request, start, tempDatabaseFile } from "./helpers.ts";

test("a transaction whose SQLite write fails aborts instead of completing", async () => {
  const file = tempDatabaseFile();
  let failWrites = false;
  const errors: unknown[] = [];
  const wrap = (sqlite: SyncSqlite): SyncSqlite => ({
    exec: (sql) => sqlite.exec(sql),
    prepare: (sql) => {
      const statement = sqlite.prepare(sql);
      return {
        all: (params) => statement.all(params),
        run: (params) => {
          if (failWrites && sql.startsWith("INSERT OR REPLACE INTO idb_record"))
            throw new Error("disk full");
          statement.run(params);
        },
      };
    },
  });
  const { factory, stats } = await start(file, {
    wrap,
    onCommitError: (error) => errors.push(error),
  });
  const db = await open(factory, "app", 1, (db) => void db.createObjectStore("s"));

  failWrites = true;
  const tx = db.transaction("s", "readwrite");
  const put = request(tx.objectStore("s").put("value", "key"));
  const outcome = new Promise<string>((resolve) => {
    tx.oncomplete = () => resolve("complete");
    tx.onabort = () => resolve(`abort: ${tx.error?.name}`);
  });
  await put; // the request itself succeeded; the commit is what fails
  assert.equal(await outcome, "abort: UnknownError");
  assert.equal(stats.failedCommits, 1);
  assert.match(String(errors[0]), /disk full/);

  // Memory was rolled back with the transaction, and the next write goes through.
  failWrites = false;
  assert.equal(await request(db.transaction("s").objectStore("s").get("key")), undefined);
  const second = db.transaction("s", "readwrite");
  second.objectStore("s").put("second", "key2");
  await done(second); // persisted once the transaction commits, not when its request succeeds
  db.close();

  const restarted = await start(file);
  const reopened = await open(restarted.factory, "app");
  const store = reopened.transaction("s").objectStore("s");
  assert.equal(await request(store.get("key")), undefined);
  assert.equal(await request(store.get("key2")), "second");
});
