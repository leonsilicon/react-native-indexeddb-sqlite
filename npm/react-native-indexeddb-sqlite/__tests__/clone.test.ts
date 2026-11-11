import assert from "node:assert/strict";
import { test } from "node:test";

import { fastClone, takeStoredJson } from "../src/clone.ts";

const sparse = [1, , 3]; // oxlint-disable-line no-sparse-arrays
const values: unknown[] = [
  0,
  "text",
  null,
  undefined,
  true,
  -0,
  NaN,
  12345678901234567890n,
  { a: [1, "two", true, null], nested: { x: 1.5 } },
  { u: undefined, n: -Infinity, d: new Date(5), big: 1n },
  { bytes: new Uint8Array([1, 2, 3]), buffer: new Uint8Array([9]).buffer },
  [new Float64Array([1.5]), new DataView(new Uint8Array([7, 8]).buffer)],
  new Map<unknown, unknown>([["k", new Set([1])]]),
  /re/g,
  sparse,
  Object.assign(Object.create(null) as object, { plain: "no prototype" }),
  JSON.parse('{"__proto__": {"x": 1}}') as unknown,
];

test("copies are equal to structuredClone's, and never the original", () => {
  for (const [i, value] of values.entries()) {
    const copy = fastClone(value);
    assert.deepEqual(copy, structuredClone(value), `values[${i}]`);
    if (typeof value === "object" && value !== null) assert.notEqual(copy, value);
  }
});

test("copies don't share nested objects or bytes with the original", () => {
  const original = { inner: { list: [1] }, bytes: new Uint8Array([1]) };
  const copy = fastClone(original) as typeof original;
  copy.inner.list.push(2);
  copy.bytes[0] = 9;
  assert.deepEqual(original, { inner: { list: [1] }, bytes: new Uint8Array([1]) });
});

test("an object reached twice stays shared, and cycles are kept, as structured clone keeps them", () => {
  const shared = { s: 1 };
  const copy = fastClone({ a: shared, b: shared }) as { a: object; b: object };
  assert.equal(copy.a, copy.b);
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic.self = cyclic;
  const cycleCopy = fastClone(cyclic) as Record<string, unknown>;
  assert.equal(cycleCopy.self, cycleCopy);
});

test("what structured clone refuses, it refuses too", () => {
  assert.throws(() => fastClone(() => 1), { name: "DataCloneError" });
  assert.throws(() => fastClone({ f: () => 1 }), { name: "DataCloneError" });
  assert.throws(() => fastClone(Symbol("s")), { name: "DataCloneError" });
});

test("a view of part of a buffer comes back as a buffer of its own bytes", () => {
  const view = new Uint8Array(new ArrayBuffer(8), 2, 3).fill(7);
  const copy = fastClone(view) as Uint8Array;
  assert.deepEqual([...copy], [7, 7, 7]);
  assert.equal(copy.byteOffset, 0);
  assert.equal(copy.buffer.byteLength, 3);
});

test("a stored JSON copy keeps its JSON text for the commit, once", () => {
  const value = { a: [1, 2], b: "x" };
  const copy = fastClone(value, true);
  assert.equal(takeStoredJson(copy), JSON.stringify(value));
  assert.equal(takeStoredJson(copy), undefined);
  assert.equal(takeStoredJson(fastClone(value)), undefined, "only stored copies keep it");
  assert.equal(takeStoredJson(fastClone({ d: new Date(1) }, true)), undefined);
});
