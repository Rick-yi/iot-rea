/**
 * export-telemetry: turn decoded observations into platform-ready artifacts.
 *
 * Output is two files, no network:
 *   mapping.json   - field contract (types, offsets, confidence, evidence)
 *   telemetry.jsonl - one normalized record per frame
 *
 * Checksum and derived (length) fields are never exported as telemetry values.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Evidence } from '../contracts/evidence.js';
import { sanitizeId } from './exportKsy.js';
import type { DerivedField } from '../domain/derived.js';
import { decodeNumber, type FieldCandidate } from '../domain/inference.js';
import { diffFrames, loadObservations, type SchemaDraft } from './diffFrames.js';

export const exportTelemetryInputSchema = z.object({
  path: z.string().min(1),
  deviceId: z.string().min(1),
  outDir: z.string().min(1),
  minConfidence: z.number().min(0).max(1).optional(),
  tsBase: z.number().int().nonnegative().optional(),
  tsStep: z.number().int().positive().optional(),
  schemaVersion: z.string().min(1).optional(),
});

export type ExportTelemetryInput = z.infer<typeof exportTelemetryInputSchema>;

export interface MappingField {
  name: string;
  offset: number;
  width: number;
  type: string;
  endian: 'be' | 'le' | null;
  confidence: number;
  scale?: number;
}

export interface MappingManifest {
  schemaVersion: string;
  deviceId: string;
  generatedAt: string;
  source: { path: string; sha256: string; size: number };
  fields: MappingField[];
  derived: DerivedField[];
  checksums: Array<{ algorithm: string; position: number; width: number; endian: 'be' | 'le' }>;
  unknowns: string[];
}

export interface TelemetryRecord {
  deviceId: string;
  ts: number;
  schemaVersion: string;
  frameId: string;
  values: Record<string, number | string>;
  quality: 'good' | 'partial';
}

export interface ExportTelemetryResult {
  mapping: MappingManifest;
  records: TelemetryRecord[];
  mappingPath: string;
  telemetryPath: string;
  evidence: Evidence;
}

export async function exportTelemetry(input: ExportTelemetryInput): Promise<ExportTelemetryResult> {
  const parsed = exportTelemetryInputSchema.parse(input);
  const minConfidence = parsed.minConfidence ?? 0.9;
  const tsStep = parsed.tsStep ?? 1000;
  const tsBase = parsed.tsBase ?? 0;
  const schemaVersion = parsed.schemaVersion ?? '1';

  const draft = await diffFrames({ path: parsed.path });
  const loaded = await loadObservations(parsed.path);

  const telemetryFields = draft.fields.filter(
    (field) => field.confidence >= minConfidence && field.type !== 'bcd2',
  );
  const mapping: MappingManifest = {
    schemaVersion,
    deviceId: parsed.deviceId,
    generatedAt: new Date().toISOString(),
    source: { path: parsed.path, sha256: loaded.digest, size: loaded.size },
    fields: telemetryFields.map((field) => ({
      name: sanitizeId(field.variable),
      offset: field.offset,
      width: field.width,
      type: field.type,
      endian: field.endian,
      confidence: field.confidence,
      scale: field.transform?.kind === 'scaled' ? field.transform.factor : undefined,
    })),
    derived: draft.derived,
    checksums: draft.checksums.map((checksum) => ({
      algorithm: checksum.algorithm,
      position: checksum.position,
      width: checksum.width,
      endian: checksum.endian,
    })),
    unknowns: draft.unknowns,
  };

  const records = loaded.observations.map((observation, index) => {
    const values: Record<string, number | string> = {};
    let partial = false;

    for (const field of telemetryFields) {
      const decoded = decodeTelemetryValue(field, observation.bytes);
      if (decoded === null) {
        partial = true;
        continue;
      }
      values[sanitizeId(field.variable)] = decoded;
    }

    // A frame is partial when a labelled variable could not be decoded at all.
    const labelled = Object.keys(observation.vars);
    if (labelled.some((variable) => !(sanitizeId(variable) in values))) {
      partial = true;
    }

    return {
      deviceId: parsed.deviceId,
      ts: tsBase + index * tsStep,
      schemaVersion,
      frameId: observation.frameId,
      values,
      quality: (partial ? 'partial' : 'good') as TelemetryRecord['quality'],
    };
  });

  await mkdir(parsed.outDir, { recursive: true });
  const mappingPath = path.join(parsed.outDir, 'mapping.json');
  const telemetryPath = path.join(parsed.outDir, 'telemetry.jsonl');
  await writeFile(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`, 'utf8');
  await writeFile(telemetryPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');

  return {
    mapping,
    records,
    mappingPath,
    telemetryPath,
    evidence: {
      source: { path: parsed.path, sha256: loaded.digest, size: loaded.size },
      limitations: [
        'telemetry values are decoded hypotheses; confidence below the threshold was excluded',
        'checksum and derived length fields are never exported as telemetry',
        'timestamps are synthetic (ts-base + index * ts-step); replace them with real timestamps if available',
        ...draft.unknowns,
      ],
    },
  };
}

function decodeTelemetryValue(field: FieldCandidate, bytes: Buffer): number | string | null {
  if (field.offset + field.width > bytes.length) return null;
  if (field.type === 'ascii') {
    return bytes.subarray(field.offset, field.offset + field.width).toString('ascii');
  }
  const raw = decodeNumber(field.type, field.endian ?? null, bytes, field.offset, field.width, field.bitOffset);
  if (raw === null) return null;
  return field.transform?.kind === 'scaled' ? raw / (field.transform.factor ?? 1) : raw;
}