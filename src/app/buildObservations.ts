/**
 * build-observations: capture + labels -> diff-frames input.
 *
 * This bridges the two halves of the workflow. It only reshapes producer
 * observations; it does not assume a protocol, a dissector or a frame layout.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Evidence } from '../contracts/evidence.js';
import { IotReaError } from '../contracts/errors.js';
import type { LabelMap, LabelValue } from '../domain/labels.js';
import { parseLabels } from '../domain/labels.js';
import { inspectPacketCapture, type TsharkRow } from '../providers/tshark.js';

export const buildObservationsInputSchema = z.object({
  path: z.string().min(1),
  payloadField: z.string().min(1).optional(),
  labelsPath: z.string().min(1).optional(),
  labelsFormat: z.enum(['auto', 'csv', 'json']).optional(),
  displayFilter: z.string().optional(),
  decodeAs: z.array(z.string().min(1)).max(1024).optional(),
  packetLimit: z.number().int().positive().optional(),
});

export type BuildObservationsInput = z.infer<typeof buildObservationsInputSchema>;

export interface DraftObservation {
  frameId: string;
  vars: Record<string, LabelValue>;
  hex: string;
}

export interface AssembleStats {
  frames: number;
  withPayload: number;
  skippedNoPayload: number;
  unlabelled: number;
  malformedHex: number;
}

export interface AssembledObservations {
  observations: DraftObservation[];
  stats: AssembleStats;
  unknowns: string[];
}

export interface BuildObservationsResult {
  observations: DraftObservation[];
  stats: AssembleStats;
  unknowns: string[];
  evidence: Evidence;
}

export function rowsToObservations(
  rows: TsharkRow[],
  payloadField: string,
  labels: LabelMap,
): AssembledObservations {
  const observations: DraftObservation[] = [];
  const stats: AssembleStats = {
    frames: rows.length,
    withPayload: 0,
    skippedNoPayload: 0,
    unlabelled: 0,
    malformedHex: 0,
  };

  for (const row of rows) {
    const raw = row.fields[payloadField];
    const hex = normalizeHex(raw);
    if (hex === null) {
      stats.skippedNoPayload += 1;
      continue;
    }
    stats.withPayload += 1;

    const frameId = String(row.frameNumber);
    const vars = labels.get(frameId);
    if (vars === undefined) stats.unlabelled += 1;

    observations.push({ frameId, vars: vars ?? {}, hex });
  }

  const unknowns: string[] = [];
  if (stats.skippedNoPayload > 0) {
    unknowns.push(
      `${stats.skippedNoPayload} of ${stats.frames} frame(s) had no "${payloadField}" value and were omitted; ` +
        'a dissector may have consumed the payload, or the filter may exclude it',
    );
  }
  if (stats.unlabelled > 0) {
    unknowns.push(
      `${stats.unlabelled} observation(s) carry no labels and contribute alignment only; field inference needs labelled samples`,
    );
  }
  if (stats.malformedHex > 0) {
    unknowns.push(`${stats.malformedHex} payload value(s) were not valid hex and were skipped`);
  }
  if (rows.length === 0) {
    unknowns.push('no frame matched the selected filter and packet limit; this does not prove absence outside that scope');
  }

  return { observations, stats, unknowns };
}

export function normalizeHex(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const joined = Array.isArray(value) ? value.join('') : value;
  const cleaned = joined.replace(/0x/gi, '').replace(/[\s:,_-]/g, '').toLowerCase();
  if (cleaned === '' || cleaned.length % 2 !== 0 || !/^[0-9a-f]+$/.test(cleaned)) return null;
  return cleaned;
}

export async function loadLabels(
  labelsPath: string,
  format: 'auto' | 'csv' | 'json' = 'auto',
): Promise<LabelMap> {
  let text: string;
  try {
    text = await readFile(labelsPath, 'utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `cannot read labels at ${labelsPath}: ${message}`, {
      path: labelsPath,
    });
  }
  try {
    return parseLabels(text, format);
  } catch (cause) {
    if (cause instanceof IotReaError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `cannot parse labels at ${labelsPath}: ${message}`, {
      path: labelsPath,
    });
  }
}

export async function buildObservations(input: BuildObservationsInput): Promise<BuildObservationsResult> {
  const parsed = buildObservationsInputSchema.parse(input);
  const payloadField = parsed.payloadField ?? 'data.data';
  const labels =
    parsed.labelsPath === undefined ? new Map() : await loadLabels(parsed.labelsPath, parsed.labelsFormat ?? 'auto');

  const page = await inspectPacketCapture({
    path: parsed.path,
    fields: [payloadField],
    displayFilter: parsed.displayFilter,
    decodeAs: parsed.decodeAs,
    packetLimit: parsed.packetLimit,
    matchLimit: null,
  });

  const assembled = rowsToObservations(page.rows, payloadField, labels);
  const limitations = [...(page.evidence.limitations ?? []), ...assembled.unknowns];

  return {
    observations: assembled.observations,
    stats: assembled.stats,
    unknowns: assembled.unknowns,
    evidence: { ...page.evidence, limitations },
  };
}
