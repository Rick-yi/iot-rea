/**
 * Derived-field detection.
 *
 * Some fields carry no business value: they describe the frame itself. v1
 * detects length-like fields by recomputing a declared relation over every
 * sample. It does not guess semantics: a field is reported only when the
 * relation holds for all samples and at least two distinct values are seen.
 */
import type { Observation } from './diff.js';

export type DerivedRelation = 'frame-length' | 'remaining-length';

export interface DerivedField {
  offset: number;
  width: number;
  type: 'u8' | 'u16';
  endian: 'be' | 'le' | null;
  relation: DerivedRelation;
  matched: number;
  total: number;
  confidence: number;
  frameIds: string[];
}

export interface DerivedOptions {
  /** Checksum or other derived positions that must not be reported as fields. */
  excludeOffsets?: ReadonlySet<number>;
}

const TYPE_SPECS: Array<{ type: 'u8' | 'u16'; width: number; endian: 'be' | 'le' | null }> = [
  { type: 'u8', width: 1, endian: null },
  { type: 'u16', width: 2, endian: 'be' },
  { type: 'u16', width: 2, endian: 'le' },
];

export function detectDerivedFields(
  observations: Observation[],
  options: DerivedOptions = {},
): DerivedField[] {
  if (observations.length < 2) return [];

  const lengths = new Set(observations.map((observation) => observation.bytes.length));
  if (lengths.size < 2) {
    // Constant frame length carries no information: every constant value would
    // "explain" it, which is not evidence.
    return [];
  }

  const candidates: DerivedField[] = [];

  for (const spec of TYPE_SPECS) {
    for (let offset = 0; offset + spec.width <= minLength(observations); offset += 1) {
      if (overlapsExcluded(offset, spec.width, options.excludeOffsets)) continue;

      for (const relation of ['frame-length', 'remaining-length'] as DerivedRelation[]) {
        const values: number[] = [];
        let matched = 0;

        for (const observation of observations) {
          const decoded = decode(observation.bytes, offset, spec);
          if (decoded === null) continue;
          values.push(decoded);
          const expected =
            relation === 'frame-length'
              ? observation.bytes.length
              : observation.bytes.length - (offset + spec.width);
          if (decoded === expected) matched += 1;
        }

        if (matched !== observations.length) continue;
        if (new Set(values).size < 2) continue;

        candidates.push({
          offset,
          width: spec.width,
          type: spec.type,
          endian: spec.endian,
          relation,
          matched,
          total: observations.length,
          confidence: 1,
          frameIds: observations.map((observation) => observation.frameId),
        });
      }
    }
  }

  // One candidate per offset/width: keep the first relation (frame-length
  // before remaining-length) and the narrowest type.
  const byField = new Map<string, DerivedField>();
  for (const candidate of candidates) {
    const key = `${candidate.offset}:${candidate.width}`;
    if (!byField.has(key)) byField.set(key, candidate);
  }

  return [...byField.values()].sort((a, b) => a.offset - b.offset || a.width - b.width);
}

function decode(
  bytes: Buffer,
  offset: number,
  spec: { type: 'u8' | 'u16'; width: number; endian: 'be' | 'le' | null },
): number | null {
  if (offset + spec.width > bytes.length) return null;
  if (spec.type === 'u8') return bytes[offset] ?? null;
  return spec.endian === 'le' ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
}

function minLength(observations: Observation[]): number {
  let length = Number.POSITIVE_INFINITY;
  for (const observation of observations) length = Math.min(length, observation.bytes.length);
  return Number.isFinite(length) ? length : 0;
}

function overlapsExcluded(
  offset: number,
  width: number,
  excluded: ReadonlySet<number> | undefined,
): boolean {
  if (excluded === undefined) return false;
  for (let index = offset; index < offset + width; index += 1) {
    if (excluded.has(index)) return true;
  }
  return false;
}
