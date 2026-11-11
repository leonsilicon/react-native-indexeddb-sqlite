// How records are written to SQLite.
//
// Keys become the TEXT primary key. Only uniqueness matters, because fake-indexeddb keeps the
// records ordered in memory; strings and numbers get a short prefix, everything else a tagged
// JSON form.
//
// Values have a fast path for plain JSON ("J" + JSON) and a tagged path ("T" + JSON) for what
// JSON cannot represent: undefined, NaN/Infinity/-0, BigInt, Date, RegExp, ArrayBuffer, typed
// arrays and DataView, Map, Set, and sparse arrays.
//
// A record's binary data (ArrayBuffers and typed arrays) is stored as a BLOB next to its text,
// which refers to it by offset and length (`encodeRecordValue`): copying bytes is much cheaper
// than building and parsing base64 in JavaScript. Records written before kept their bytes as
// base64 in the text, which still decodes.

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
  | { $: "AB"; o: number; l: number }
  | { $: "TV"; c: string; o: number; l: number }
  | { $: "m"; v: [Tagged, Tagged][] }
  | { $: "s"; v: Tagged[] }
  | { $: "o"; v: Record<string, Tagged> };

/** Where `tag` puts binary data: base64 in the text (`null`), or byte ranges of the BLOB. */
type Parts = { chunks: Uint8Array[]; length: number } | null;

function binary(bytes: Uint8Array, parts: Parts): { o: number; l: number } | { v: string } {
  if (!parts) return { v: toBase64(bytes) };
  const o = parts.length;
  parts.chunks.push(bytes);
  parts.length += bytes.byteLength;
  return { o, l: bytes.byteLength };
}

function tag(value: unknown, parts: Parts = null): Tagged {
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
        i in value ? tag(value[i], parts) : { $: "hole" },
      ),
    };
  }
  if (value instanceof Date) return { $: "d", v: value.getTime() };
  if (value instanceof RegExp) return { $: "re", s: value.source, f: value.flags };
  if (value instanceof ArrayBuffer) {
    const data = binary(new Uint8Array(value), parts);
    return "v" in data ? { $: "ab", v: data.v } : { $: "AB", ...data };
  }
  if (ArrayBuffer.isView(value)) {
    const c = value.constructor.name;
    const data = binary(viewBytes(value), parts);
    return "v" in data ? { $: "tv", c, v: data.v } : { $: "TV", c, ...data };
  }
  if (value instanceof Map) {
    return {
      $: "m",
      v: [...value].map(([k, v]): [Tagged, Tagged] => [tag(k, parts), tag(v, parts)]),
    };
  }
  if (value instanceof Set) return { $: "s", v: [...value].map((item) => tag(item, parts)) };
  const out: Record<string, Tagged> = {};
  for (const key of Object.keys(value))
    out[key] = tag((value as Record<string, unknown>)[key], parts);
  return { $: "o", v: out };
}

function view(c: string, buffer: ArrayBuffer): ArrayBufferView {
  const View = VIEW_CONSTRUCTORS[c];
  if (!View) throw new TypeError(`react-native-indexeddb-sqlite: unknown view type ${c}`);
  return new View(buffer);
}

function blobBytes(blob: Uint8Array | null, o: number, l: number): ArrayBuffer {
  if (!blob || o + l > blob.byteLength) {
    throw new TypeError("react-native-indexeddb-sqlite: a record's binary data is missing");
  }
  return bufferOf(blob.subarray(o, o + l));
}

function untag(value: Tagged, blob: Uint8Array | null): unknown {
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
        if (typeof item !== "object" || item === null || item.$ !== "hole")
          out[i] = untag(item, blob);
      });
      return out;
    }
    case "d":
      return new Date(value.v);
    case "re":
      return new RegExp(value.s, value.f);
    case "ab":
      return bufferOf(fromBase64(value.v));
    case "tv":
      return view(value.c, bufferOf(fromBase64(value.v)));
    case "AB":
      return blobBytes(blob, value.o, value.l);
    case "TV":
      return view(value.c, blobBytes(blob, value.o, value.l));
    case "m":
      return new Map(value.v.map(([k, v]) => [untag(k, blob), untag(v, blob)]));
    case "s":
      return new Set(value.v.map((item) => untag(item, blob)));
    case "o": {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value.v)) out[key] = untag(value.v[key], blob);
      return out;
    }
  }
}

/** A value as one string, binary data included as base64. */
export function encodeValue(value: unknown): string {
  return isPlainJson(value) ? "J" + JSON.stringify(value) : "T" + JSON.stringify(tag(value));
}

/**
 * Decodes what `encodeValue` or `encodeRecordValue` produced. `blob` is the binary data
 * `encodeRecordValue` returned with the text, if any.
 */
export function decodeValue(text: string, blob?: Uint8Array | null): unknown {
  const body: unknown = JSON.parse(text.slice(1));
  return text[0] === "J" ? body : untag(body as Tagged, blob ?? null);
}

/**
 * A value as text plus, when it holds binary data, a BLOB of the bytes, which the text refers
 * to by offset and length. `json` is the value's JSON text, when the caller already has it.
 */
export function encodeRecordValue(
  value: unknown,
  json?: string,
): [text: string, blob: Uint8Array | null] {
  if (json !== undefined) return ["J" + json, null];
  if (isPlainJson(value)) return ["J" + JSON.stringify(value), null];
  const parts = { chunks: [] as Uint8Array[], length: 0 };
  const text = "T" + JSON.stringify(tag(value, parts));
  const { chunks } = parts;
  if (chunks.length === 0) return [text, null];
  // SQLite copies the bytes it binds, so a lone chunk can go as it is unless it views part of
  // a larger buffer (some bindings send the whole buffer).
  if (chunks.length === 1) {
    const only = chunks[0]!;
    const whole = only.byteOffset === 0 && only.byteLength === only.buffer.byteLength;
    return [text, whole ? only : only.slice()];
  }
  const blob = new Uint8Array(parts.length);
  let at = 0;
  for (const chunk of chunks) {
    blob.set(chunk, at);
    at += chunk.byteLength;
  }
  return [text, blob];
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
