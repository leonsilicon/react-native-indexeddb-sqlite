// The scheduler fake-indexeddb runs its tasks on (request callbacks, commits, opens).
//
// fake-indexeddb queues each task with `setImmediate`. On React Native without the bridge,
// `setImmediate` is `queueMicrotask`, so a chain of awaited requests (a crypto store reading
// and writing one key after another) runs to its end without the event loop turning once:
// no frame, timer or touch gets in. A plain `setTimeout` per task would let the loop turn,
// but costs a turn of the event loop per request.
//
// This one keeps the microtask timing while a burst is short, and slices it when it isn't:
//
// - A slice starts when the first task runs in a turn of the event loop, and one
//   `setTimeout(0)` is queued to mark its end.
// - While the slice has run for less than `budgetMs`, each task runs as a microtask, as
//   fake-indexeddb's `setImmediate` ran it there, only a few microtask hops later
//   (`hops`, below).
// - Once the slice has run over budget, every task due to run (and every task queued after
//   it) moves to a queue that the `setTimeout` drains in the next turn, oldest first, as a
//   new slice. Each task carries the sequence number it was queued with, so tasks queued
//   before the deferral stay ahead of later ones whichever way they reach the queue.
//
// Only fake-indexeddb's own tasks move. The microtasks of the code using IndexedDB (an
// `await` between two requests of one transaction) still run before the next task, and a
// transaction only commits from a task that finds no request left, so deferring a task
// never commits a transaction early: it only gives the caller longer to add requests.
//
// The hops: a transaction commits when the task after a request's success event finds no
// new request. In a browser (and in Node, where setImmediate is a macrotask) the caller's
// whole chain of microtasks runs before that task, so any number of `await`s may separate
// two requests. As a microtask, the task runs after the microtasks queued so far but before
// the ones those queue, so only a one-step continuation got its next request in: two
// `await`s in between (an async helper that returns the request's promise) and the
// transaction had already committed. Each task therefore waits `hops` more microtasks before
// it runs, which lets chains of up to `hops + 1` microtasks through and keeps the order of
// the tasks among themselves.

export interface TaskSchedulerOptions {
  /** How long one slice of tasks may run before the rest wait for the next turn. Default 8 ms. */
  budgetMs?: number;
  /** Extra microtasks a task waits before it runs within a slice (see above). Default 3. */
  hops?: number;
  now?: () => number;
  queueMicrotask?: (task: () => void) => void;
  setTimeout?: (task: () => void, ms: number) => unknown;
  /**
   * Where an error a task throws goes. The default rethrows it from a timer, as an uncaught
   * error, the way it would have surfaced from `setImmediate`, without stopping the other tasks.
   */
  onError?: (error: unknown) => void;
}

export interface TaskSchedulerStats {
  /** Tasks run. */
  tasks: number;
  /** Tasks that waited for a later turn of the event loop because their slice ran over budget. */
  deferredTasks: number;
  /** Turns of the event loop that ran deferred tasks. */
  deferredSlices: number;
}

export interface TaskScheduler {
  queueTask(this: void, task: () => void): void;
  readonly stats: TaskSchedulerStats;
  /** The budget of a slice, which can be changed at any time. */
  budgetMs: number;
}

interface Queued {
  run: () => void;
  seq: number;
  /** Microtask hops still to wait before it runs. */
  hops: number;
  /** Takes the next hop (one closure per task). */
  step: () => void;
}

function rethrow(error: unknown): void {
  setTimeout(() => {
    throw error;
  }, 0);
}

export function createTaskScheduler(options: TaskSchedulerOptions = {}): TaskScheduler {
  let budget = options.budgetMs ?? 8;
  const hops = options.hops ?? 3;
  const report = options.onError ?? rethrow;
  const now = options.now ?? (() => performance.now());
  const microtask = options.queueMicrotask ?? ((task: () => void) => queueMicrotask(task));
  const later = options.setTimeout ?? ((task: () => void, ms: number) => setTimeout(task, ms));
  const stats: TaskSchedulerStats = { tasks: 0, deferredTasks: 0, deferredSlices: 0 };

  let nextSeq = 0;
  // When the current slice began, or -1 between slices.
  let sliceStart = -1;
  let turnQueued = false;
  // Tasks waiting for the next turn, in sequence order.
  let deferred: Queued[] = [];

  const overBudget = (): boolean => sliceStart >= 0 && now() - sliceStart >= budget;

  function queueTurn(): void {
    if (turnQueued) return;
    turnQueued = true;
    later(onTurn, 0);
  }

  function beginSlice(): void {
    if (sliceStart >= 0) return;
    sliceStart = now();
    queueTurn();
  }

  function run(task: Queued): void {
    stats.tasks++;
    try {
      task.run();
    } catch (error) {
      report(error);
    }
  }

  function defer(task: Queued): void {
    stats.deferredTasks++;
    // Almost always the newest; otherwise find its place by sequence number.
    let i = deferred.length;
    while (i > 0 && deferred[i - 1]!.seq > task.seq) i--;
    deferred.splice(i, 0, task);
    queueTurn();
  }

  // A task's microtask: wait its hops (unless tasks are waiting for the next turn already,
  // which runs after every microtask anyway), then run it, or defer it if the slice is over.
  function step(task: Queued): void {
    if (deferred.length === 0 && task.hops > 0) {
      task.hops--;
      microtask(task.step);
      return;
    }
    if (deferred.length > 0 || overBudget()) {
      defer(task);
      return;
    }
    beginSlice();
    run(task);
  }

  // A new turn of the event loop: the slice before it has ended. Run what waited for it,
  // oldest first, until this slice is over budget too. Tasks these queue run as microtasks
  // after this turn's tasks (or join the queue behind them), like any other.
  function onTurn(): void {
    turnQueued = false;
    sliceStart = -1;
    if (deferred.length === 0) return;
    stats.deferredSlices++;
    beginSlice();
    const batch = deferred;
    deferred = [];
    let i = 0;
    while (i < batch.length) {
      run(batch[i]!);
      i++;
      if (overBudget()) break;
    }
    if (i < batch.length) {
      // Nothing joined the queue meanwhile (new tasks wait in microtasks), but keep order anyway.
      deferred = batch.slice(i).concat(deferred);
      queueTurn();
    }
  }

  return {
    stats,
    get budgetMs() {
      return budget;
    },
    set budgetMs(ms: number) {
      budget = ms;
    },
    queueTask(fn: () => void): void {
      const task = { run: fn, seq: nextSeq++, hops } as Queued;
      if (deferred.length > 0) {
        defer(task);
        return;
      }
      task.step = () => step(task);
      microtask(task.step);
    },
  };
}
