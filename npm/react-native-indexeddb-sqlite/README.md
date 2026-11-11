# react-native-indexeddb-sqlite

A persistent IndexedDB for React Native. [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB), a spec-compliant in-memory implementation, serves every read; each committed transaction is written through to SQLite with [expo-sqlite](https://docs.expo.dev/versions/latest/sdk/sqlite/)'s synchronous API.

React Native has no IndexedDB, and libraries written for the browser expect one. The motivating case is matrix-js-sdk's Rust crypto store (`@matrix-org/matrix-sdk-crypto-wasm`), which reaches IndexedDB through wasm-bindgen and is used by [react-native-matrix-sdk-crypto-wasm](https://github.com/leonsilicon/react-native-matrix-sdk-crypto-wasm).

## Usage

```sh
npx expo install expo-sqlite
npm install react-native-indexeddb-sqlite
```

Then apply [`patches/fake-indexeddb@6.2.7.patch`](patches/fake-indexeddb@6.2.7.patch), which this package ships, to fake-indexeddb: with Bun or pnpm, copy it into your project and list it under `patchedDependencies` (`"fake-indexeddb@6.2.7": "patches/fake-indexeddb@6.2.7.patch"`); with npm, use patch-package. It adds two hooks, for the scheduler and the clone below. Without it everything still works, but IndexedDB work never yields to the event loop on React Native (see How it works), and the package warns once.

```ts
import { openDatabaseSync } from "expo-sqlite";
import { installPersistentIndexedDB } from "react-native-indexeddb-sqlite";
import { expoSqlite } from "react-native-indexeddb-sqlite/expo";

// Before anything opens a database. Defines indexedDB, IDBKeyRange, IDBRequest, ... on globalThis.
await installPersistentIndexedDB({ sqlite: expoSqlite(openDatabaseSync("indexeddb.db")) });
```

Options:

- `target`: where to define `indexedDB` and the `IDB*` classes. The default is `globalThis`; pass `null` to use the returned `factory` directly.
- `synchronous`: SQLite's `synchronous` setting (the journal is always WAL). `"NORMAL"` (the default) survives an app crash but can lose the last transactions on a power loss. `"FULL"` survives both and is slower.
- `sliceMs`: how long IndexedDB work may hold the JavaScript thread before the event loop gets a turn: fake-indexeddb's tasks, loading a database, building an index. The default is 8 ms. `false` keeps fake-indexeddb's own scheduling and loads each database in one go.
- `fastClone`: copy values with the fast paths described below rather than `structuredClone`. The default is `true`.
- `onCommitError(error)`: called when writing a transaction to SQLite fails. The transaction is then aborted, as it would be in a browser.
- `onLoadError(name, error)`: called when loading a database from SQLite fails. Opening it then fails (`VersionError`), and nothing can overwrite what is on disk until the database is deleted.

It returns `{ factory, stats, scheduler }`. `stats` counts what was loaded from SQLite and written to it, and how long that took; `scheduler` counts the tasks the scheduler deferred to a later turn of the event loop (null when fake-indexeddb isn't patched).

In Node (tests, tooling), use `nodeSqlite(new DatabaseSync(file))` from `react-native-indexeddb-sqlite/node` with Node's built-in `node:sqlite`.

With matrix-js-sdk on React Native, the crypto store's IndexedDB lookup also needs `globalThis.global` to exist. [react-native-matrix-sdk-crypto-wasm](https://github.com/leonsilicon/react-native-matrix-sdk-crypto-wasm) defines it; with `-org/matrix-sdk-crypto-wasm` set up some other way, add `globalThis.global ??= globalThis`. It then works with `initRustCrypto({ useIndexedDB: true })`, with or without a storage key or password.

## How it works

- **Reads** never touch SQLite.
- **Writes**: the layer records which keys each IndexedDB transaction touches. When the transaction commits, those records are written to SQLite in one SQLite transaction, before `complete` fires. If the SQLite write fails, the IndexedDB transaction aborts instead (memory rolled back, `abort` fired), so a write is never reported done without being on disk. An aborted transaction writes nothing.
- **Loading**: a database is loaded from SQLite the first time it is opened or deleted, a slice of `sliceMs` at a time with a turn of the event loop between slices. The open waits for the load in fake-indexeddb's queue of connection requests, so nothing sees a half-loaded database. `databases()` lists what is on disk without loading it. Indexes are rebuilt from the records rather than stored: a unique one during the load (it has to reject duplicates), the others in the background after it, a slice at a time. An index read before its background build has finished is built there and then; a build that sees its store change starts again later.
- **Scheduling**: fake-indexeddb queues its tasks (a request's result, the next request, a commit) with `setImmediate`, which on React Native is a microtask, so a chain of awaited requests ran to its end without a frame, a timer or a touch getting in. With the patch, its tasks still run as microtasks (a few microtasks later, so a caller may `await` a few times between two requests of one transaction, as it can in a browser), until they have held the thread for `sliceMs`; the rest then run in the next turn of the event loop, in the order they were queued. Only fake-indexeddb's tasks move, never the caller's microtasks, and a transaction only commits from a task that finds no request left, so deferring a task can't commit a transaction early.
- **Cloning**: IndexedDB copies every value it stores or returns. `structuredClone` on React Native is a JavaScript polyfill that walks the value property by property; with the patch, values made of plain objects, arrays, strings, numbers, booleans and null are copied by the engine's JSON functions instead (after one quick walk to check), ArrayBuffers and typed arrays with one `slice()`, and only other values (`Map`, `Set`, shared or cyclic objects, ...) by `structuredClone`. A stored value's JSON text is kept until the commit, which writes it as it is. One difference from structured clone: a typed array that views part of a larger buffer comes back viewing just its own bytes (as it always did after a restart).
- **Storage format**: two tables, `idb_database` (each database's version and schema as JSON) and `idb_record` (one row per record). Plain-JSON values are stored as JSON. Values JSON cannot represent (typed arrays, `Map`, `Set`, `Date`, `BigInt`, `undefined`, `-0`, sparse arrays) are stored in a tagged form, with their binary data in a BLOB column next to the text. (Before 0.2, binary data was stored as base64 in the text, which still loads.)

## Performance

These were measured with matrix-js-sdk's crypto store (matrix-sdk-crypto-wasm 18.9.0) on the iOS simulator (Expo SDK 58, React Native 0.88.1, Apple silicon Mac). Physical phones are slower.

|                                                  | This package                        | indexeddbshim + react-native-sqlite-2 |
| ------------------------------------------------ | ----------------------------------- | ------------------------------------- |
| Encrypt a message                                | 0.35 ms                             | 34 ms                                 |
| Decrypt a message after an app restart           | 0.8–0.9 ms                          | 67 ms                                 |
| Passphrase-encrypted store                       | works                               | fails (`cannot commit`)               |
| Write 3,000 rooms' keys                          | 1.8 ms/room (SQLite: 0.2 ms/commit) | —                                     |
| Cold start of a 3,000-room store (6,000 records) | 396 ms                              | —                                     |

## Limits

- **The whole database is in memory.** Loading costs about 65 µs per record on the simulator, and memory grows with the data. A store with tens of thousands of records takes seconds to load, although the app stays responsive while it does. Keep large binary data (media, sound banks) in files and store their paths.
- **Commits are synchronous.** Each one is a short SQLite transaction on the JavaScript thread, so `complete` means the data is on disk. A transaction that writes megabytes holds the thread for as long as SQLite takes to write them.
- **A transaction can commit early on React Native** when its caller awaits something that is not a microtask (a timer, a network request, native code) between two of its requests, or more than a few microtasks while the scheduler runs tasks as microtasks. In a browser that also commits the transaction (the next request fails with `TransactionInactiveError`); keep each transaction's requests together.
- **One process per SQLite file.** Another process, such as an iOS notification service extension, cannot share the store safely.
- **It depends on fake-indexeddb internals.** fake-indexeddb is pinned to the exact version the hooks were written for (6.2.7); upgrade the two together.
- **Runtime requirements.** It needs a global `structuredClone` and `DOMException`, which Expo provides. On older Hermes versions it adds `Array.prototype.findLast`.
