import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeKey, decodeValue, encodeKey, encodeValue } from "../src/encoding.ts";

test("plain JSON values take the fast path", () => {
  const value = { a: [1, "two", true, null], nested: { x: 1.5 } };
  const encoded = encodeValue(value);
  assert.equal(encoded[0], "J");
  assert.deepEqual(decodeValue(encoded), value);
});

test("everything else structured clone allows round-trips through the tagged path", () => {
  const sparse = [1, , 3]; // oxlint-disable-line no-sparse-arrays
  const values: unknown[] = [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    -0,
    12345678901234567890n,
    new Date(1_700_000_000_000),
    /a+b/gi,
    new Uint8Array([0, 1, 254, 255]),
    new Uint8Array(new ArrayBuffer(8), 2, 3).fill(7),
    new Float64Array([1.5, -2.25]),
    new BigInt64Array([-1n, 2n]),
    new DataView(new Uint8Array([1, 2, 3]).buffer),
    new Uint8Array([1, 2, 3, 4, 5]).buffer,
    new Map<unknown, unknown>([
      ["k", new Set([1, "s"])],
      [1, undefined],
    ]),
    sparse,
    { inner: { u: undefined, bytes: new Uint8Array([42]) }, $: "not a tag" },
  ];
  for (const value of values) {
    const encoded = encodeValue(value);
    assert.equal(encoded[0], "T", `tagged: ${String(value)}`);
    assert.deepEqual(decodeValue(encoded), value);
  }
  const decodedSparse = decodeValue(encodeValue(sparse)) as unknown[];
  assert.equal(1 in decodedSparse, false, "holes stay holes");
});

test("keys of every valid type round-trip, and distinct keys encode differently", () => {
  const keys = [
    "plain",
    "",
    "s123",
    0,
    -1.5,
    Infinity,
    new Date(0),
    new Uint8Array([1, 2]).buffer,
    ["a", 1, new Date(2), ["nested"]],
  ];
  for (const key of keys) assert.deepEqual(decodeKey(encodeKey(key)), key);
  assert.equal(new Set(keys.map(encodeKey)).size, keys.length);
  assert.notEqual(encodeKey("1"), encodeKey(1));
});
