# react-native-indexeddb-sqlite

A persistent IndexedDB for React Native: fake-indexeddb in memory, written through to SQLite. The published package is [`npm/react-native-indexeddb-sqlite`](npm/react-native-indexeddb-sqlite/README.md).

This is a [Flatcap](https://github.com/leonsilicon/flatcap) workspace (Bun, Vite+).

```sh
vp install
vpr test     # node:test on node:sqlite: persistence, aborts, upgrades, commit failures, loading, scheduling, cloning, matrix crypto store
vpr build    # dist/ (JavaScript and declarations) with tsc
vp check     # format, lint (Flatcap rules), typecheck
```

The tests run the TypeScript sources directly in Node 24+. They cover what this layer adds on top of fake-indexeddb, which has its own conformance suite:

- after a restart (a new instance on the same SQLite file), records, indexes, key generators and schema changes are all still there
- aborted transactions never reach the disk
- a failed SQLite write aborts its transaction
- a database loads a slice at a time while the event loop keeps turning, opens and deletes wait for the load, and indexes build in the background, starting over when their store changes
- binary data goes in a BLOB, and records written with base64 still load
- the scheduler keeps fake-indexeddb's tasks in order, lets the event loop turn during a long chain of requests, and doesn't change the order of IndexedDB's events when it defers them
- the fast clone matches `structuredClone`
- matrix-js-sdk's Rust crypto store survives a restart, encrypted and unencrypted, and with every task deferred

fake-indexeddb is patched (`npm/react-native-indexeddb-sqlite/patches`, which the package ships for its users to apply) with the two hooks the scheduler and the clone need.
