/**
 * Field type hypotheses, scored against labelled samples.
 *
 * A candidate is an inference, not an observation: it carries the number of
 * matching samples, the offsets tried, and the transform assumed. When no
 * candidate reaches the threshold the region stays unknown.
 */
import type { Observation } from './diff.js';

export type FieldType =
  | 'u8'
  | 'i8'
  | 'u16'
  | 'i16'
  | 'u32'
  | 'i32'
  | 'f32'
  | 'bcd2'
  | 'ascii';

export type Endian = 'be' | 'le';

export interface FieldCandidate {
  offset: number;
  width: number;
  type: FieldType;
  endian: Endian | null;
  variable: string;
  /** Fraction of samples whose decoded value matched the labelled variable. */
  confidence: number;
  matched: number;
  total: number;
  frameIds: string[];
  /** Present only when a linear transform (value -> raw) was inferred. */
  transform?: { kind: 'identity' | 'scaled'; factor?: number };
  note?: string;
}

export interface InferenceReport {
  fields: FieldCandidate[];
  unknowns: string[];
}

export const CONFIDENCE_FLOOR = 0.5;

interface TypeSpec {
  type: FieldType;
  width: number;
  endian: Endian | null;
}

const NUMERIC_TYPES: TypeSpec[] = [
  { type: 'u8', width: 1, endian: null },
  { type: 'i8', width: 1, endian: null },
  { type: 'u16', width: 2, endian: 'be' },
  { type: 'u16', width: 2, endian: 'le' },
  { type: 'i16', width: 2, endian: 'be' },
  { type: 'i16', width: 2, endian: 'le' },
  { type: 'u32', width: 4, endian: 'be' },
  { type: 'u32', width: 4, endian: 'le' },
  { type: 'i32', width: 4, endian: 'be' },
  { type: 'i32', width: 4, endian: 'le' },
  { type: 'f32', width: 4, endian: 'be' },
  { type: 'f32', width: 4, endian: 'le' },
];

export function decodeNumber(
  type: FieldType,
  endian: Endian | null,
  bytes: Buffer,
  offset: number,
  width: number,
): number | null {
  if (offset + width > bytes.length) return null;
  try {
    switch (type) {
      case 'u8':
        return bytes[offset] ?? null;
      case 'i8': {
        const value = bytes.readInt8(offset);
        return value;
      }
      case 'u16':
        return endian === 'le' ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
      case 'i16':
        return endian === 'le' ? bytes.readInt16LE(offset) : bytes.readInt16BE(offset);
      case 'u32':
        return endian === 'le' ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
      case 'i32':
        return endian === 'le' ? bytes.readInt32LE(offset) : bytes.readInt32BE(offset);
      case 'f32':
        return endian === 'le' ? bytes.readFloatLE(offset) : bytes.readFloatBE(offset);
      case 'bcd2': {
        if (width !== 2) return null;
        const hi = bytes[offset] ?? 0;
        const lo = bytes[offset + 1] ?? 0;
        if ((hi & 0x0f) > 9 || (hi >> 4) > 9 || (lo & 0x0f) > 9 || (lo >> 4) > 9) return null;
        return (hi >> 4) * 1000 + (hi & 0x0f) * 100 + (lo >> 4) * 10 + (lo & 0x0f);
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function toNumber(value: number | string | boolean | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function matchesDecodedValue(decoded: number, expected: number, type: FieldType): boolean {
  if (type === 'f32') {
    const scale = Math.max(1, Math.abs(expected));
    return Math.abs(decoded - expected) <= scale * 1e-4;
  }
  return decoded === expected;
}

/** Largest aligned length shared by every observation. */
function alignedLength(observations: Observation[]): number {
  let length = Number.POSITIVE_INFINITY;
  for (const obs of observations) length = Math.min(length, obs.bytes.length);
  return Number.isFinite(length) ? length : 0;
}

export function inferFields(
  observations: Observation[],
  candidates?: { minSamples?: number },
): InferenceReport {
  const minSamples = candidates?.minSamples ?? 3;
  const fields: FieldCandidate[] = [];
  const unknowns: string[] = [];

  if (observations.length < minSamples) {
    return {
      fields,
      unknowns: [`inference needs at least ${minSamples} observations, got ${observations.length}`],
    };
  }

  const length = alignedLength(observations);
  const variables = new Set<string>();
  for (const obs of observations) {
    for (const [key, value] of Object.entries(obs.vars)) {
      if (toNumber(value) !== null || typeof value === 'string') variables.add(key);
    }
  }

  for (const variable of variables) {
    const stringValues = observations.every((obs) => typeof obs.vars[variable] === 'string');
    const best = stringValues
      ? bestAsciiCandidate(observations, variable, length)
      : bestNumericCandidate(observations, variable, length);

    if (best !== null) {
      fields.push(best);
      continue;
    }
    unknowns.push(`no field hypothesis reached confidence ${CONFIDENCE_FLOOR} for variable "${variable}"`);
  }

  return { fields, unknowns };
}

function bestNumericCandidate(
  observations: Observation[],
  variable: string,
  length: number,
): FieldCandidate | null {
  let best: FieldCandidate | null = null;
  const total = observations.length;

  for (const spec of NUMERIC_TYPES) {
    for (const transform of transformsFor(observations, variable, spec, length)) {
      for (let offset = 0; offset + spec.width <= length; offset += 1) {
        let matched = 0;
        for (const obs of observations) {
          const expected = toNumber(obs.vars[variable]);
          if (expected === null) continue;
          const raw = decodeNumber(spec.type, spec.endian, obs.bytes, offset, spec.width);
          if (raw === null) continue;
          const value = transform.kind === 'scaled' ? raw / (transform.factor ?? 1) : raw;
          if (matchesDecodedValue(value, expected, spec.type)) matched += 1;
        }
        const confidence = matched / total;
        if (confidence < CONFIDENCE_FLOOR) continue;
        if (best !== null && confidence < best.confidence) continue;
        if (best !== null && confidence === best.confidence && spec.width < best.width) continue;
        best = {
          offset,
          width: spec.width,
          type: spec.type,
          endian: spec.endian,
          variable,
          confidence,
          matched,
          total,
          frameIds: observations.map((obs) => obs.frameId),
          transform,
          note:
            confidence < 1
              ? `${total - matched} sample(s) did not match; hypothesis is partial`
              : undefined,
        };
      }
    }
  }

  return best;
}

function transformsFor(
  observations: Observation[],
  variable: string,
  spec: TypeSpec,
  length: number,
): Array<{ kind: 'identity' | 'scaled'; factor?: number }> {
  const transforms: Array<{ kind: 'identity' | 'scaled'; factor?: number }> = [{ kind: 'identity' }];
  if (spec.type !== 'f32') return transforms;

  // Integer-valued sensors commonly ship scaled floats (0.1, 0.01, 1000).
  const samples: Array<{ raw: number; expected: number }> = [];
  for (const obs of observations) {
    const expected = toNumber(obs.vars[variable]);
    if (expected === null || expected === 0) continue;
    for (let offset = 0; offset + spec.width <= length; offset += 1) {
      const raw = decodeNumber(spec.type, spec.endian, obs.bytes, offset, spec.width);
      if (raw === null || raw === 0) continue;
      samples.push({ raw, expected });
      break;
    }
  }
  for (const factor of [0.1, 0.01, 0.001, 10, 100, 1000]) {
    const hits = samples.filter((sample) => Math.abs(sample.raw / factor - sample.expected) <= Math.abs(sample.expected) * 1e-4);
    if (hits.length >= samples.length * 0.8 && samples.length > 0) {
      transforms.push({ kind: 'scaled', factor });
    }
  }
  return transforms;
}

function bestAsciiCandidate(
  observations: Observation[],
  variable: string,
  length: number,
): FieldCandidate | null {
  let best: FieldCandidate | null = null;
  for (let offset = 0; offset < length; offset += 1) {
    let matched = 0;
    let widest = 1;
    for (const obs of observations) {
      const expected = String(obs.vars[variable]);
      const expectedBytes = Buffer.from(expected, 'ascii');
      if (expectedBytes.length === 0) continue;
      const slice = obs.bytes.subarray(offset, offset + expectedBytes.length);
      if (slice.length === expectedBytes.length && slice.equals(expectedBytes)) {
        matched += 1;
        widest = Math.max(widest, expectedBytes.length);
      }
    }
    const confidence = matched / observations.length;
    if (confidence < CONFIDENCE_FLOOR) continue;
    if (best !== null && confidence < best.confidence) continue;
    best = {
      offset,
      width: widest,
      type: 'ascii',
      endian: null,
      variable,
      confidence,
      matched,
      total: observations.length,
      frameIds: observations.map((obs) => obs.frameId),
    };
  }
  return best;
}
