# react-native-indexeddb-sqlite

A persistent IndexedDB for React Native: fake-indexeddb in memory, written through to SQLite. The published package is [`npm/react-native-indexeddb-sqlite`](npm/react-native-indexeddb-sqlite/README.md).

This is a [Flatcap](https://github.com/leonsilicon/flatcap) workspace (Bun, Vite+).

```sh
vp install
vpr test     # node:test on node:sqlite: persistence, aborts, upgrades, commit failures, matrix crypto store
vpr build    # dist/ (JavaScript and declarations) with tsc
vp check     # format, lint (Flatcap rules), typecheck
```

The tests run the TypeScript sources directly in Node 24+. They cover what this layer adds on top of fake-indexeddb, which has its own conformance suite:

- after a restart (a new instance on the same SQLite file), records, indexes, key generators and schema changes are all still there
- aborted transactions never reach the disk
- a failed SQLite write aborts its transaction
- matrix-js-sdk's Rust crypto store survives a restart, encrypted and unencrypted
