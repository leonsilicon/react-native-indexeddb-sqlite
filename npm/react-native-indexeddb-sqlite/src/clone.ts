// The clone fake-indexeddb makes of every value it stores and every value and key it hands
// back. On React Native `structuredClone` is a JavaScript polyfill (core-js, or Expo's
// @ungap/structured-clone) that walks the value property by property; this one takes a
// cheaper path whenever the value allows it:
//
// - primitives are returned as they are;
// - a value made only of plain objects, dense arrays, strings, finite numbers, booleans and
//   null is copied by the engine's native JSON.stringify and JSON.parse (one quick walk
//   first checks that it is);
// - a value that also holds undefined, other numbers, bigints, Dates, ArrayBuffers or typed
//   arrays is copied by a direct walk, with each buffer copied in one `slice()`;
// - anything else (Map, Set, RegExp, Error, sparse arrays, class instances, and any object
//   reached twice, which structured clone keeps shared) goes to `structuredClone`.
//
// The fast paths differ from structured clone in one way: a typed array that views part of
// a larger buffer comes back viewing a buffer of just its own bytes, as it also does after
// a restart (only the viewed bytes are persisted).
//
// For a value being stored, the JSON text of the fast path is kept with the copy, so the
// commit that writes it to SQLite doesn't stringify it again (see `storedJson`).

const JSON_KIND = 0;
const STRUCT_KIND = 1;
const OTHER_KIND = 2;
type Kind = typeof JSON_KIND | typeof STRUCT_KIND | typeof OTHER_KIND;

/** The JSON text of stored copies made by the JSON path, until the commit that writes them. */
const storedJson = new WeakMap<object, string>();

/** The JSON text `fastClone(value, true)` produced `value` from, if it took the JSON path. */
export function takeStoredJson(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const json = storedJson.get(value);
  if (json !== undefined) storedJson.delete(value);
  return json;
}

/** Forgets the JSON text of a stored copy that was changed after it was made. */
export function forgetStoredJson(value: unknown): void {
  if (typeof value === "object" && value !== null) storedJson.delete(value);
}

function kindOf(value: unknown, seen: Set<object>): Kind {
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON_KIND;
    case "number":
      return Number.isFinite(value) && !Object.is(value, -0) ? JSON_KIND : STRUCT_KIND;
    case "undefined":
    case "bigint":
      return STRUCT_KIND;
    case "object":
      break;
    default:
      // Functions and symbols: structuredClone throws the DataCloneError.
      return OTHER_KIND;
  }
  if (value === null) return JSON_KIND;
  if (seen.has(value)) return OTHER_KIND;
  seen.add(value);
  let kind: Kind = JSON_KIND;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) return OTHER_KIND;
      const item = kindOf(value[i], seen);
      if (item === OTHER_KIND) return OTHER_KIND;
      if (item > kind) kind = item;
    }
    return kind;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Date) {
    return STRUCT_KIND;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return OTHER_KIND;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const item = kindOf((value as Record<string, unknown>)[key], seen);
    if (item === OTHER_KIND) return OTHER_KIND;
    if (item > kind) kind = item;
  }
  return kind;
}

function cloneView(view: ArrayBufferView): ArrayBufferView {
  if (view instanceof DataView) {
    return new DataView(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  return (view as Uint8Array).slice();
}

/** Copies a value `kindOf` found to be JSON or STRUCT. */
function cloneStruct(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) out.push(cloneStruct(value[i]));
    return out;
  }
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return cloneView(value);
  const out: Record<string, unknown> = {};
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const item = cloneStruct((value as Record<string, unknown>)[key]);
    if (key === "__proto__") {
      Object.defineProperty(out, key, {
        value: item,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      out[key] = item;
    }
  }
  return out;
}

/**
 * Structured clone, with fast paths for the values IndexedDB usually holds. `stored` marks
 * a copy that is about to be stored, whose JSON text the commit can reuse.
 */
export function fastClone(value: unknown, stored = false): unknown {
  if (typeof value !== "object" || value === null) {
    if (typeof value === "function" || typeof value === "symbol") return structuredClone(value);
    return value;
  }
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return cloneView(value);
  const kind = kindOf(value, new Set());
  if (kind === JSON_KIND) {
    const json = JSON.stringify(value);
    const copy = JSON.parse(json) as object;
    if (stored) storedJson.set(copy, json);
    return copy;
  }
  if (kind === STRUCT_KIND) return cloneStruct(value);
  return structuredClone(value);
}
