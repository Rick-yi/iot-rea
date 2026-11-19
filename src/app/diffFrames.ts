/**
 * diff-frames: label-in, schema-draft-out.
 *
 * The caller supplies observations that vary exactly one business value per
 * sample. Output separates what the differential observed (variable regions)
 * from what it inferred (field types), and leaves everything else unknown.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Evidence } from '../contracts/evidence.js';
import { IotReaError } from '../contracts/errors.js';
import type { ChecksumCandidate } from '../domain/checksum.js';
import { checksumCandidates } from '../domain/checksum.js';
import type { DerivedField } from '../domain/derived.js';
import { detectDerivedFields } from '../domain/derived.js';
import type { CountField } from '../domain/records.js';
import { detectCountFields } from '../domain/records.js';
import type { AlignmentInfo, DiffReport, Observation } from '../domain/diff.js';
import { diffObservations } from '../domain/diff.js';
import type { FieldCandidate } from '../domain/inference.js';
import { inferFields } from '../domain/inference.js';
import { parseHex } from '../domain/frame.js';
import { fileSize, sha256File } from '../providers/process.js';

export const observationSchema = z.object({
  frameId: z.string().min(1),
  vars: z.record(z.union([z.number(), z.string(), z.boolean()])),
  hex: z.string().min(2),
});

export const diffFramesInputSchema = z.object({
  path: z.string().min(1),
  minSamples: z.number().int().min(2).max(1000).optional(),
  matchLimit: z.number().int().positive().nullable().optional(),
});

export type DiffFramesInput = z.infer<typeof diffFramesInputSchema>;

export interface SchemaDraft {
  sampleCount: number;
  differential: DiffReport;
  fields: FieldCandidate[];
  checksums: ChecksumCandidate[];
  /** Length-like fields that describe the frame rather than the payload. */
  derived: DerivedField[];
  /** Count fields with a constant record stride. */
  records: CountField[];
  unknowns: string[];
  evidence: Evidence;
}

export interface LoadedObservations {
  observations: Observation[];
  digest: string;
  size: number;
}

export async function loadObservations(pathname: string): Promise<LoadedObservations> {
  const size = await fileSize(pathname);
  const digest = await sha256File(pathname);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(pathname, 'utf8'));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `cannot read observations from ${pathname}: ${message}`, {
      path: pathname,
    });
  }

  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { observations?: unknown }).observations)
      ? (raw as { observations: unknown[] }).observations
      : null;
    if (list === null) {
    throw new IotReaError('invalid_request', 'observations must be an array or {"observations": [...]}');
  }

  const parsed = z.array(observationSchema).parse(list);
  const observations: Observation[] = [];
  for (const entry of parsed) {
    const bytes = parseHex(entry.hex);
    if (bytes === null) {
      throw new IotReaError('invalid_request', `frame "${entry.frameId}" has an invalid hex payload`);
    }
    observations.push({ frameId: entry.frameId, vars: entry.vars, bytes });
  }

  return { observations, digest, size };
}

/** Use a detected length field to justify a common payload window. */
export function deriveAlignment(observations: Observation[], derived: DerivedField[]): AlignmentInfo | null {
  const field =
    derived.find((candidate) => candidate.relation === 'remaining-length' && candidate.confidence >= 1) ??
    derived.find((candidate) => candidate.relation === 'frame-length' && candidate.confidence >= 1);
  if (field === undefined) return null;

  const payloadStart = field.offset + field.width;
  let payloadLength = Number.POSITIVE_INFINITY;

  for (const observation of observations) {
    const value = readFieldValue(observation.bytes, field);
    if (value === null) return null;
    const length = field.relation === 'remaining-length' ? value : value - payloadStart;
    if (length < 1) return null;
    if (observation.bytes.length < payloadStart + length) return null;
    payloadLength = Math.min(payloadLength, length);
  }

  if (!Number.isFinite(payloadLength)) return null;
  return {
    kind: 'length-field',
    fieldOffset: field.offset,
    fieldWidth: field.width,
    payloadStart,
    payloadLength,
  };
}

function readFieldValue(bytes: Buffer, field: DerivedField): number | null {
  if (field.offset + field.width > bytes.length) return null;
  if (field.type === 'u8') return bytes[field.offset] ?? null;
  return field.endian === 'le'
    ? bytes.readUInt16LE(field.offset)
    : bytes.readUInt16BE(field.offset);
}

export async function diffFrames(input: DiffFramesInput): Promise<SchemaDraft> {
  const parsed = diffFramesInputSchema.parse(input);
  const { observations, digest, size } = await loadObservations(parsed.path);

  const checksums = checksumCandidates(observations);

  // Checksums are derived bytes: mask them out of variability analysis and
  // field inference so a changing CRC is not mistaken for a payload field.
  const masked = new Set<number>();
  for (const candidate of checksums.candidates) {
    if (candidate.confidence < 0.8) continue;
    for (let index = candidate.position; index < candidate.position + candidate.width; index += 1) {
      masked.add(index);
    }
  }

  const derived = detectDerivedFields(observations, { excludeOffsets: masked });
  const records = detectCountFields(observations, {
    excludeOffsets: masked,
    excludeRanges: derived.map((field) => ({ offset: field.offset, width: field.width })),
  });
  const alignment = deriveAlignment(observations, derived);
  const differential = diffObservations(observations, { excludeOffsets: masked, alignment: alignment ?? undefined });
  const inference = inferFields(observations, { minSamples: parsed.minSamples ?? 3 }, { excludeOffsets: masked });

  const unknowns = [
    ...differential.unknowns,
    ...inference.unknowns,
    ...checksums.unknowns,
    ...(masked.size > 0
      ? [`${masked.size} byte(s) were masked as derived (checksum); they are not treated as payload fields`]
      : []),
    ...records.map(
      (field) =>
        `count field at 0x${field.offset.toString(16)} implies ${field.stride}-byte records with a ${field.trailerBytes}-byte trailer`,
    ),
    'frame layout outside the compared prefix is not addressed by positional alignment',
    'field semantics (units, scaling, signedness) are hypotheses until replayed on a device',
  ];

  const draft: SchemaDraft = {
    sampleCount: observations.length,
    differential,
    fields: inference.fields,
    checksums: checksums.candidates,
    derived,
    records,
    unknowns,
    evidence: {
      source: { path: parsed.path, sha256: digest, size },
      limitations: unknowns,
    },
  };

  if (parsed.matchLimit !== undefined && parsed.matchLimit !== null) {
    draft.fields = draft.fields.slice(0, parsed.matchLimit);
    draft.checksums = draft.checksums.slice(0, parsed.matchLimit);
  }

  return draft;
}
