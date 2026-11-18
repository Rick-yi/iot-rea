/**
 * Single-variable differential analysis.
 *
 * The caller supplies observations where every field except one is held
 * constant. Alignment is deliberate and conservative:
 *   - equal lengths: positional alignment is an observation
 *   - unequal lengths: only the common prefix is compared, and the tail is
 *     reported as unknown rather than guessed at
 */
import type { Frame } from './frame.js';

export interface Observation {
  /** Native id of the frame this sample came from. */
  frameId: string;
  /** Business values for this sample, e.g. { temperature: 21.0 }. */
  vars: Record<string, number | string | boolean>;
  bytes: Buffer;
}

export interface VariableRegion {
  offset: number;
  /** Inclusive offset of the last byte in the region. */
  end: number;
  width: number;
  /** Highest single-byte distinct-value count inside the region. */
  maxDistinct: number;
  /** Fraction of samples whose byte differs from the most common byte. */
  variability: number;
  frameIds: string[];
}

export interface DiffReport {
  sampleCount: number;
  lengths: number[];
  alignedLength: number;
  regions: VariableRegion[];
  /** Offsets whose value never changed across samples. */
  stableOffsets: number[];
  unknowns: string[];
  /** Frames that did not take part because their length was shorter. */
  excludedFrameIds: string[];
  /** Offsets excluded from variability analysis, e.g. detected checksums. */
  maskedOffsets?: number[];
}

const VARIABLE_THRESHOLD = 0.1;

export interface DiffOptions {
  /** Byte positions known to be derived (checksums); they are not treated as fields. */
  excludeOffsets?: ReadonlySet<number>;
}

export function diffObservations(observations: Observation[], options: DiffOptions = {}): DiffReport {
  if (observations.length < 2) {
    return {
      sampleCount: observations.length,
      lengths: observations.map((obs) => obs.bytes.length),
      alignedLength: observations[0]?.bytes.length ?? 0,
      regions: [],
      stableOffsets: [],
      unknowns: ['at least two observations are required for a differential'],
      excludedFrameIds: [],
    };
  }

  const lengths = observations.map((obs) => obs.bytes.length);
  // A single truncated sample must not silently shorten every other frame: the
  // dominant length is the alignment anchor, outliers are excluded and named.
  const alignedLength = dominantLength(lengths);
  const unknowns: string[] = [];
  if (unique(lengths).length > 1) {
    unknowns.push(
      `frame lengths differ (${unique(lengths).join(', ')}); only the ${alignedLength}-byte prefix was compared`,
    );
  }

  const excludedFrameIds: string[] = [];
  const usable = observations.filter((obs) => {
    const keep = obs.bytes.length >= alignedLength;
    if (!keep) excludedFrameIds.push(obs.frameId);
    return keep;
  });

  const regions: VariableRegion[] = [];
  const stableOffsets: number[] = [];
  let current: VariableRegion | null = null;

  const excluded = options.excludeOffsets;

  for (let offset = 0; offset < alignedLength; offset += 1) {
    if (excluded?.has(offset) === true) {
      // Derived bytes are masked: they stay out of the variable regions and
      // out of field inference, but are recorded so callers can see the mask.
      stableOffsets.push(offset);
      if (current !== null) {
        regions.push(current);
        current = null;
      }
      continue;
    }

    const values = usable.map((obs) => obs.bytes[offset] ?? 0);
    const distinct = new Set(values).size;
    const common = mostCommon(values);
    const changed = values.filter((value) => value !== common.value).length;
    const variability = values.length === 0 ? 0 : changed / values.length;
    const variable = distinct > 1 && variability >= VARIABLE_THRESHOLD;

    if (variable) {
      if (current === null) {
        current = {
          offset,
          end: offset,
          width: 1,
          maxDistinct: distinct,
          variability,
          frameIds: usable.map((obs) => obs.frameId),
        };
      } else {
        current.end = offset;
        current.width += 1;
        current.maxDistinct = Math.max(current.maxDistinct, distinct);
        current.variability = Math.max(current.variability, variability);
      }
      continue;
    }

    stableOffsets.push(offset);
    if (current !== null) {
      regions.push(current);
      current = null;
    }
  }
  if (current !== null) regions.push(current);

  if (regions.length === 0) {
    unknowns.push('no byte varied across the supplied observations; check that the samples really differ');
  }

  return {
    sampleCount: usable.length,
    lengths,
    alignedLength,
    regions,
    stableOffsets,
    unknowns,
    excludedFrameIds,
    maskedOffsets: excluded === undefined ? undefined : [...excluded].filter((offset) => offset < alignedLength),
  };
}

function mostCommon(values: number[]): { value: number; count: number } {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = { value: values[0] ?? 0, count: 0 };
  for (const [value, count] of counts) {
    if (count > best.count) best = { value, count };
  }
  return best;
}

function unique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function dominantLength(values: number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let bestValue = values[0] ?? 0;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value > bestValue)) {
      bestValue = value;
      bestCount = count;
    }
  }
  return bestValue;
}

/** Frames are convenient observations; vars are supplied by the experiment log. */
export function framesToObservations(
  frames: Frame[],
  varsFor: (frame: Frame) => Record<string, number | string | boolean>,
): Observation[] {
  return frames.map((frame) => ({
    frameId: frame.nativeId,
    vars: varsFor(frame),
    bytes: frame.bytes,
  }));
}
