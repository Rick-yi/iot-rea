/**
 * Count-field / repeated-record detection.
 *
 * A count field is accepted only when, for every sample, the declared count
 * times a constant stride exactly consumes the bytes after the field (minus a
 * constant trailer). The count must vary across samples; a constant count is
 * not evidence. This is structural: it does not claim the records' semantics.
 */
import type { Observation } from './diff.js';

export interface CountField {
  offset: number;
  width: number;
  type: 'u8' | 'u16';
  endian: 'be' | 'le' | null;
  /** Constant record size in bytes. */
  stride: number;
  /** Constant bytes after the last record (e.g. a checksum). */
  trailerBytes: number;
  matched: number;
  total: number;
  confidence: number;
  frameIds: string[];
}

export interface CountOptions {
  /** Checksum bytes and other masked positions. */
  excludeOffsets?: ReadonlySet<number>;
  /** Length-derived fields are not counts; skip their byte ranges. */
  excludeRanges?: Array<{ offset: number; width: number }>;
}

const TYPE_SPECS: Array<{ type: 'u8' | 'u16'; width: number; endian: 'be' | 'le' | null }> = [
  { type: 'u8', width: 1, endian: null },
  { type: 'u16', width: 2, endian: 'be' },
  { type: 'u16', width: 2, endian: 'le' },
];

const MAX_STRIDE = 32;
const MAX_TRAILER = 16;

export function detectCountFields(
  observations: Observation[],
  options: CountOptions = {},
): CountField[] {
  if (observations.length < 3) return [];

  const minLength = Math.min(...observations.map((observation) => observation.bytes.length));
  const candidates: CountField[] = [];

  for (const spec of TYPE_SPECS) {
    for (let offset = 0; offset + spec.width <= minLength; offset += 1) {
      if (overlaps(offset, spec.width, options.excludeOffsets, options.excludeRanges)) continue;

      const values: number[] = [];
      let complete = true;
      for (const observation of observations) {
        const value = decode(observation.bytes, offset, spec);
        if (value === null || value < 1) {
          complete = false;
          break;
        }
        values.push(value);
      }
      if (!complete) continue;
      if (new Set(values).size < 2) continue;

      for (let stride = 1; stride <= MAX_STRIDE; stride += 1) {
        const trailers = observations.map((observation, index) => {
          const count = values[index] ?? 0;
          return observation.bytes.length - (offset + spec.width) - count * stride;
        });
        if (trailers.some((trailer) => trailer < 0 || trailer > MAX_TRAILER)) continue;
        if (new Set(trailers).size !== 1) continue;

        candidates.push({
          offset,
          width: spec.width,
          type: spec.type,
          endian: spec.endian,
          stride,
          trailerBytes: trailers[0] ?? 0,
          matched: observations.length,
          total: observations.length,
          confidence: 1,
          frameIds: observations.map((observation) => observation.frameId),
        });
      }
    }
  }

  // One candidate per field: smallest trailer, then largest stride, then offset.
  const best = new Map<string, CountField>();
  for (const candidate of candidates) {
    const key = `${candidate.offset}:${candidate.width}`;
    const current = best.get(key);
    if (
      current === undefined ||
      candidate.trailerBytes < current.trailerBytes ||
      (candidate.trailerBytes === current.trailerBytes && candidate.stride > current.stride)
    ) {
      best.set(key, candidate);
    }
  }

  return [...best.values()].sort((a, b) => a.offset - b.offset || a.width - b.width);
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

function overlaps(
  offset: number,
  width: number,
  excluded: ReadonlySet<number> | undefined,
  ranges: Array<{ offset: number; width: number }> | undefined,
): boolean {
  for (let index = offset; index < offset + width; index += 1) {
    if (excluded?.has(index) === true) return true;
  }
  for (const range of ranges ?? []) {
    if (offset < range.offset + range.width && range.offset < offset + width) return true;
  }
  return false;
}