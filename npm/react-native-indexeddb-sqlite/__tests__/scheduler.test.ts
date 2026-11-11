// The slicing scheduler (src/scheduler.ts) on its own, with a clock the tests move, and then
// fake-indexeddb running on it: request chains inside one transaction still complete, the
// event loop gets turns during a long chain, and the order of IndexedDB's events is the same
// whether or not tasks were deferred.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createTaskScheduler } from "../src/scheduler.ts";
import { done, open, request, start, tempDatabaseFile } from "./helpers.ts";

/** A scheduler on a manual clock, with its `setTimeout`s collected rather than run. */
function manual(budgetMs: number) {
  let time = 0;
  const timers: (() => void)[] = [];
  const errors: unknown[] = [];
  const scheduler = createTaskScheduler({
    budgetMs,
    now: () => time,
    setTimeout: (task) => void timers.push(task),
    onError: (error) => errors.push(error),
  });
  return {
    scheduler,
    errors,
    advance: (ms: number) => void (time += ms),
    /** Runs the oldest pending turn, as the event loop would, then its microtasks. */
    turn: async (): Promise<boolean> => {
      const task = timers.shift();
      if (!task) return false;
      task();
      await new Promise<void>((resolve) => setImmediate(resolve));
      return true;
    },
    pendingTurns: () => timers.length,
  };
}

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

test("within budget, tasks run as microtasks in the order they were queued", async () => {
  const { scheduler } = manual(8);
  const order: string[] = [];
  scheduler.queueTask(() => order.push("a"));
  scheduler.queueTask(() => {
    order.push("b");
    scheduler.queueTask(() => order.push("d"));
  });
  scheduler.queueTask(() => order.push("c"));
  assert.deepEqual(order, []);
  await flushMicrotasks();
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  assert.equal(scheduler.stats.deferredTasks, 0);
});

test("other microtasks still run between tasks, where setImmediate-as-microtask ran them", async () => {
  const { scheduler } = manual(8);
  const order: string[] = [];
  scheduler.queueTask(() => {
    order.push("task 1");
    void Promise.resolve().then(() => order.push("microtask from task 1"));
    scheduler.queueTask(() => order.push("task 2"));
  });
  await flushMicrotasks();
  assert.deepEqual(order, ["task 1", "microtask from task 1", "task 2"]);
});

test("over budget, the rest wait for the next turn, oldest first, and only tasks move", async () => {
  const { scheduler, advance, turn } = manual(8);
  const order: string[] = [];
  // Task 1 takes the whole budget. Tasks 2 and 3 were queued before it ran and must still run
  // before anything queued later; the microtask task 1 queues still runs this turn.
  scheduler.queueTask(() => {
    order.push("1");
    advance(10);
    void Promise.resolve().then(() => {
      order.push("microtask");
      scheduler.queueTask(() => order.push("5"));
    });
    scheduler.queueTask(() => order.push("4"));
  });
  scheduler.queueTask(() => order.push("2"));
  scheduler.queueTask(() => order.push("3"));
  await flushMicrotasks();
  assert.deepEqual(order, ["1", "microtask"]);
  assert.equal(scheduler.stats.deferredTasks, 4);
  assert.equal(await turn(), true); // ends the first slice and runs the deferred tasks
  assert.deepEqual(order, ["1", "microtask", "2", "3", "4", "5"]);
});

test("a deferred batch that runs over budget again keeps the rest in order", async () => {
  const { scheduler, advance, turn, pendingTurns } = manual(8);
  const order: number[] = [];
  for (let i = 0; i < 6; i++) {
    scheduler.queueTask(() => {
      order.push(i);
      advance(5);
      // Each task also queues a follow-up, which must come after every task queued before it.
      scheduler.queueTask(() => order.push(100 + i));
    });
  }
  await flushMicrotasks();
  // Slice 1: tasks 0 and 1 (10 ms), then everything waits.
  assert.deepEqual(order, [0, 1]);
  while (pendingTurns() > 0) await turn();
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 100, 101, 102, 103, 104, 105]);
});

test("a task queued while others wait goes behind them, even from another turn", async () => {
  const { scheduler, advance, turn } = manual(8);
  const order: string[] = [];
  scheduler.queueTask(() => {
    order.push("long");
    advance(20);
  });
  scheduler.queueTask(() => order.push("queued before"));
  await flushMicrotasks();
  // Some other macrotask (a touch, a timer) queues a task before the scheduler's turn.
  scheduler.queueTask(() => order.push("queued after"));
  await flushMicrotasks();
  assert.deepEqual(order, ["long"]);
  await turn();
  assert.deepEqual(order, ["long", "queued before", "queued after"]);
});

test("a task that throws doesn't stop the others", async () => {
  const { scheduler, errors, advance, turn } = manual(8);
  const order: string[] = [];
  scheduler.queueTask(() => {
    throw new Error("boom");
  });
  scheduler.queueTask(() => order.push("after"));
  await flushMicrotasks();
  // The same in a deferred batch.
  scheduler.queueTask(() => advance(10));
  scheduler.queueTask(() => {
    throw new Error("deferred boom");
  });
  scheduler.queueTask(() => order.push("after deferred"));
  await flushMicrotasks();
  await turn();
  await turn();
  assert.deepEqual(order, ["after", "after deferred"]);
  assert.deepEqual(
    errors.map((error) => (error as Error).message),
    ["boom", "deferred boom"],
  );
});

// fake-indexeddb on the scheduler. `sliceMs: 0` defers after every task: the harshest timing.

/** One more microtask: awaiting an already-resolved promise. */
const hop = (): Promise<void> => Promise.resolve();

/**
 * Puts and reads back 200 records in one transaction, with `extra` more microtasks after each
 * request's own `await`, as wasm-bindgen futures or an async helper add.
 */
async function chain(sliceMs: number, extra: number): Promise<void> {
  const { factory } = await start(tempDatabaseFile(), { sliceMs });
  const db = await open(factory, "app", 1, (db) => void db.createObjectStore("s"));
  const tx = db.transaction("s", "readwrite");
  const store = tx.objectStore("s");
  for (let i = 0; i < 200; i++) {
    await request(store.put(i, i));
    for (let k = 0; k < extra; k++) await hop();
    assert.equal(await request(store.get(i)), i);
    for (let k = 0; k < extra; k++) await hop();
  }
  await done(tx);
  const read = db.transaction("s");
  assert.equal(await request(read.objectStore("s").count()), 200);
}

test("awaited request chains inside one transaction complete, with up to 3 more awaits between requests", async () => {
  for (let extra = 0; extra <= 3; extra++) await chain(8, extra);
});

test("with every task deferred (sliceMs 0), any number of awaits between requests works", async () => {
  await chain(0, 10);
});

test("a long chain of requests lets the event loop turn", async () => {
  const { factory, scheduler } = await start(tempDatabaseFile(), { sliceMs: 2 });
  assert.ok(scheduler, "fake-indexeddb is patched to use the scheduler");
  const db = await open(factory, "app", 1, (db) => void db.createObjectStore("s"));
  let turns = 0;
  let finished = false;
  const tick = () => {
    if (finished) return;
    turns++;
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  const tx = db.transaction("s", "readwrite");
  const store = tx.objectStore("s");
  const started = performance.now();
  for (let i = 0; i < 5000; i++) await request(store.put({ i, text: "x".repeat(50) }, i));
  await done(tx);
  finished = true;
  const tookMs = performance.now() - started;
  // Without slicing the chain would run to its end in microtasks: no timer at all.
  assert.ok(turns > 0, `the event loop turned ${turns} times in ${tookMs.toFixed(0)} ms`);
  assert.ok(scheduler.deferredSlices > 0);
});

/**
 * A workload of overlapping transactions, cursors, an abort and a version change. Returns the
 * order its IndexedDB events fired in.
 */
async function workload(sliceMs: number): Promise<string[]> {
  const { factory } = await start(tempDatabaseFile(), { sliceMs });
  const log: string[] = [];
  const db = await open(factory, "app", 1, (db) => {
    db.createObjectStore("a");
    db.createObjectStore("b").createIndex("byX", "x");
  });
  const transactions: Promise<unknown>[] = [];
  for (let t = 0; t < 6; t++) {
    const scope = t % 3 === 0 ? ["a"] : t % 3 === 1 ? ["b"] : ["a", "b"];
    const tx = db.transaction(scope, t === 4 ? "readonly" : "readwrite");
    transactions.push(
      new Promise((resolve) => {
        tx.oncomplete = () => resolve(log.push(`tx${t} complete`));
        tx.onabort = () => resolve(log.push(`tx${t} abort`));
      }),
    );
    for (const name of scope) {
      const store = tx.objectStore(name);
      if (t !== 4) {
        for (let i = 0; i < 3; i++) {
          const put = store.put({ x: i * t }, `${t}-${i}`);
          put.onsuccess = () => log.push(`tx${t} put ${name} ${i}`);
        }
      }
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return void log.push(`tx${t} cursor ${name} end`);
        log.push(`tx${t} cursor ${name} ${JSON.stringify(c.key)}`);
        c.continue();
      };
    }
    if (t === 5) tx.objectStore("a").get("0-0").onsuccess = () => tx.abort();
  }
  await Promise.all(transactions);
  db.close();
  const upgraded = await open(factory, "app", 2, () => log.push("upgrade"));
  log.push(`version ${upgraded.version}`);
  return log;
}

test("deferring tasks doesn't change the order of IndexedDB's events", async () => {
  const microtasks = await workload(1_000_000);
  const deferred = await workload(0);
  assert.deepEqual(deferred, microtasks);
  assert.ok(microtasks.includes("tx5 abort"));
});
