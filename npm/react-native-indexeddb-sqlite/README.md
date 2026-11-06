# react-native-indexeddb-sqlite

A persistent IndexedDB for React Native. [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB), a spec-compliant in-memory implementation, serves every read; each committed transaction is written through to SQLite with [expo-sqlite](https://docs.expo.dev/versions/latest/sdk/sqlite/)'s synchronous API.

React Native has no IndexedDB, and libraries written for the browser expect one. The motivating case is matrix-js-sdk's Rust crypto store (`@matrix-org/matrix-sdk-crypto-wasm`), which reaches IndexedDB through wasm-bindgen and is used by [react-native-matrix-sdk-crypto-wasm](https://github.com/leonsilicon/react-native-matrix-sdk-crypto-wasm).

## Usage

```sh
npx expo install expo-sqlite
npm install react-native-indexeddb-sqlite
```

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
- `onCommitError(error)`: called when writing a transaction to SQLite fails. The transaction is then aborted, as it would be in a browser.

It returns `{ factory, stats }`. `stats` counts what was loaded from SQLite and written to it, and how long that took.

In Node (tests, tooling), use `nodeSqlite(new DatabaseSync(file))` from `react-native-indexeddb-sqlite/node` with Node's built-in `node:sqlite`.

With matrix-js-sdk on React Native, the crypto store's IndexedDB lookup also needs `globalThis.global` to exist. [react-native-matrix-sdk-crypto-wasm](https://github.com/leonsilicon/react-native-matrix-sdk-crypto-wasm) defines it; with `-org/matrix-sdk-crypto-wasm` set up some other way, add `globalThis.global ??= globalThis`. It then works with `initRustCrypto({ useIndexedDB: true })`, with or without a storage key or password.

## How it works

- **Reads** never touch SQLite.
- **Writes**: the layer records which keys each IndexedDB transaction touches. When the transaction commits, those records are written to SQLite in one SQLite transaction, before `complete` fires. If the SQLite write fails, the IndexedDB transaction aborts instead (memory rolled back, `abort` fired), so a write is never reported done without being on disk. An aborted transaction writes nothing.
- **Loading**: a database is loaded from SQLite the first time it is opened, deleted or listed. Indexes are rebuilt from the records rather than stored.
- **Storage format**: two tables, `idb_database` (each database's version and schema as JSON) and `idb_record` (one row per record). Plain-JSON values are stored as JSON. Values JSON cannot represent (typed arrays, `Map`, `Set`, `Date`, `BigInt`, `undefined`, `-0`, sparse arrays) are stored in a tagged form.

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

- **The whole database is in memory.** Loading costs about 65 µs per record on the simulator, and memory grows with the data. A store with tens of thousands of records takes seconds to load.
- **One process per SQLite file.** Another process, such as an iOS notification service extension, cannot share the store safely.
- **It depends on fake-indexeddb internals.** fake-indexeddb is pinned to the exact version the hooks were written for (6.2.7); upgrade the two together.
- **Runtime requirements.** It needs a global `structuredClone` and `DOMException`, which Expo provides. On older Hermes versions it adds `Array.prototype.findLast`.
