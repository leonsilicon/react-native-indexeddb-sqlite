// How records are written to SQLite.
//
// Keys become the TEXT primary key. Only uniqueness matters, because fake-indexeddb keeps the
// records ordered in memory; strings and numbers get a short prefix, everything else a tagged
// JSON form.
//
// Values have a fast path for plain JSON ("J" + JSON) and a tagged path ("T" + JSON) for what
// JSON cannot represent: undefined, NaN/Infinity/-0, BigInt, Date, RegExp, ArrayBuffer, typed
// arrays and DataView, Map, Set, and sparse arrays.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < B64.length; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out +=
      B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + "=";
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let j = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n =
      (B64_LOOKUP[text.charCodeAt(i)] << 18) |
      (B64_LOOKUP[text.charCodeAt(i + 1)] << 12) |
      (B64_LOOKUP[text.charCodeAt(i + 2)] << 6) |
      B64_LOOKUP[text.charCodeAt(i + 3)];
    if (j < bytes.length) bytes[j++] = n >> 16;
    if (j < bytes.length) bytes[j++] = (n >> 8) & 255;
    if (j < bytes.length) bytes[j++] = n & 255;
  }
  return bytes;
}

type ViewConstructor = new (buffer: ArrayBuffer) => ArrayBufferView;

const VIEW_CONSTRUCTORS: Record<string, ViewConstructor> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
};

function viewBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** A copy of the bytes, as a standalone ArrayBuffer. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isPlainJson(value: unknown): boolean {
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value) && !Object.is(value, -0);
    case "object": {
      if (value === null) return true;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++)
          if (!(i in value) || !isPlainJson(value[i])) return false;
        return true;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      for (const key in value)
        if (!isPlainJson((value as Record<string, unknown>)[key])) return false;
      return true;
    }
    default:
      return false;
  }
}

type Tagged =
  | null
  | boolean
  | number
  | string
  | { $: "u" }
  | { $: "hole" }
  | { $: "n"; v: string }
  | { $: "bi"; v: string }
  | { $: "a"; v: Tagged[] }
  | { $: "d"; v: number }
  | { $: "re"; s: string; f: string }
  | { $: "ab"; v: string }
  | { $: "tv"; c: string; v: string }
  | { $: "m"; v: [Tagged, Tagged][] }
  | { $: "s"; v: Tagged[] }
  | { $: "o"; v: Record<string, Tagged> };

function tag(value: unknown): Tagged {
  switch (typeof value) {
    case "undefined":
      return { $: "u" };
    case "number":
      return Number.isFinite(value) && !Object.is(value, -0)
        ? value
        : { $: "n", v: Object.is(value, -0) ? "-0" : String(value) };
    case "bigint":
      return { $: "bi", v: value.toString() };
    case "string":
    case "boolean":
      return value;
    case "object":
      break;
    default:
      throw new TypeError(`react-native-indexeddb-sqlite: cannot store a ${typeof value}`);
  }
  if (value === null) return null;
  if (Array.isArray(value)) {
    return {
      $: "a",
      v: Array.from({ length: value.length }, (_, i) =>
        i in value ? tag(value[i]) : { $: "hole" },
      ),
    };
  }
  if (value instanceof Date) return { $: "d", v: value.getTime() };
  if (value instanceof RegExp) return { $: "re", s: value.source, f: value.flags };
  if (value instanceof ArrayBuffer) return { $: "ab", v: toBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value))
    return { $: "tv", c: value.constructor.name, v: toBase64(viewBytes(value)) };
  if (value instanceof Map)
    return { $: "m", v: [...value].map(([k, v]): [Tagged, Tagged] => [tag(k), tag(v)]) };
  if (value instanceof Set) return { $: "s", v: [...value].map(tag) };
  const out: Record<string, Tagged> = {};
  for (const key of Object.keys(value)) out[key] = tag((value as Record<string, unknown>)[key]);
  return { $: "o", v: out };
}

function untag(value: Tagged): unknown {
  if (value === null || typeof value !== "object") return value;
  switch (value.$) {
    case "u":
    case "hole":
      return undefined;
    case "n":
      return Number(value.v);
    case "bi":
      return BigInt(value.v);
    case "a": {
      const out: unknown[] = [];
      out.length = value.v.length; // all holes; the loop fills every index that was not one
      value.v.forEach((item, i) => {
        if (typeof item !== "object" || item === null || item.$ !== "hole") out[i] = untag(item);
      });
      return out;
    }
    case "d":
      return new Date(value.v);
    case "re":
      return new RegExp(value.s, value.f);
    case "ab":
      return bufferOf(fromBase64(value.v));
    case "tv": {
      const View = VIEW_CONSTRUCTORS[value.c];
      if (!View) throw new TypeError(`react-native-indexeddb-sqlite: unknown view type ${value.c}`);
      return new View(bufferOf(fromBase64(value.v)));
    }
    case "m":
      return new Map(value.v.map(([k, v]) => [untag(k), untag(v)]));
    case "s":
      return new Set(value.v.map(untag));
    case "o": {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value.v)) out[key] = untag(value.v[key]);
      return out;
    }
  }
}

export function encodeValue(value: unknown): string {
  return isPlainJson(value) ? "J" + JSON.stringify(value) : "T" + JSON.stringify(tag(value));
}

export function decodeValue(text: string): unknown {
  const body: unknown = JSON.parse(text.slice(1));
  return text[0] === "J" ? body : untag(body as Tagged);
}

// IndexedDB keys: number, string, Date, binary, and arrays of those.
type TaggedKey = { s: string } | { n: string } | { d: number } | { b: string } | { a: TaggedKey[] };

function tagKey(key: unknown): TaggedKey {
  if (typeof key === "string") return { s: key };
  if (typeof key === "number") return { n: String(key) };
  if (key instanceof Date) return { d: key.getTime() };
  if (key instanceof ArrayBuffer) return { b: toBase64(new Uint8Array(key)) };
  if (ArrayBuffer.isView(key)) return { b: toBase64(viewBytes(key)) };
  if (Array.isArray(key)) return { a: key.map(tagKey) };
  throw new TypeError(`react-native-indexeddb-sqlite: not a valid key: ${String(key)}`);
}

function untagKey(key: TaggedKey): unknown {
  if ("s" in key) return key.s;
  if ("n" in key) return Number(key.n);
  if ("d" in key) return new Date(key.d);
  if ("b" in key) return bufferOf(fromBase64(key.b));
  return key.a.map(untagKey);
}

export function encodeKey(key: unknown): string {
  if (typeof key === "string") return "s" + key;
  if (typeof key === "number") return "n" + String(key);
  return "x" + JSON.stringify(tagKey(key));
}

export function decodeKey(text: string): unknown {
  if (text[0] === "s") return text.slice(1);
  if (text[0] === "n") return Number(text.slice(1));
  return untagKey(JSON.parse(text.slice(1)) as TaggedKey);
}
