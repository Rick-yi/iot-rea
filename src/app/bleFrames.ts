/**
 * ble-frames: ATT frames as first-class channels, with optional labels for a
 * direct hand-off to diff-frames.
 */
import { z } from 'zod';
import type { Evidence } from '../contracts/evidence.js';
import type { FrameRow } from '../domain/frame.js';
import type { BleStats } from '../providers/ble.js';
import { inspectBleCapture } from '../providers/ble.js';
import { framesToDraftObservations, loadLabels, type DraftObservation } from './buildObservations.js';

export const bleFramesInputSchema = z.object({
  path: z.string().min(1),
  peerAddress: z.string().min(1).optional(),
  displayFilter: z.string().optional(),
  packetLimit: z.number().int().positive().optional(),
  labelsPath: z.string().min(1).optional(),
  labelsFormat: z.enum(['auto', 'csv', 'json']).optional(),
});

export type BleFramesInput = z.infer<typeof bleFramesInputSchema>;

export interface BleFramesResult {
  frames: FrameRow[];
  observations?: DraftObservation[];
  stats: BleStats;
  unknowns: string[];
  evidence: Evidence;
}

export async function bleFrames(input: BleFramesInput): Promise<BleFramesResult> {
  const parsed = bleFramesInputSchema.parse(input);
  const page = await inspectBleCapture({
    path: parsed.path,
    peerAddress: parsed.peerAddress,
    displayFilter: parsed.displayFilter,
    packetLimit: parsed.packetLimit,
  });

  let observations: DraftObservation[] | undefined;
  const unknowns = [...page.unknowns];

  if (parsed.labelsPath !== undefined) {
    const labels = await loadLabels(parsed.labelsPath, parsed.labelsFormat ?? 'auto');
    const assembled = framesToDraftObservations(page.frames, labels);
    observations = assembled.observations;
    if (assembled.unlabelled > 0) {
      unknowns.push(
        `${assembled.unlabelled} frame(s) carry no labels and contribute alignment only; field inference needs labelled samples`,
      );
    }
  }

  return {
    frames: page.rows,
    observations,
    stats: page.stats,
    unknowns,
    evidence: {
      ...page.evidence,
      limitations: [...(page.evidence.limitations ?? []), ...unknowns],
    },
  };
}
