/**
 * Evidence pack: the input an external proposer (human or model) receives.
 *
 * The pack is deliberately bounded and explicit about omission. It lists the
 * verifiers that can actually settle a claim, so a proposer knows what is
 * checkable before inventing a hypothesis.
 */
import { z } from 'zod';
import type { Evidence, SourceEvidence } from '../contracts/evidence.js';
import type { ChecksumCandidate } from '../domain/checksum.js';
import type { DerivedField } from '../domain/derived.js';
import type { CountField } from '../domain/records.js';
import type { DiffReport, Observation } from '../domain/diff.js';
import type { FieldCandidate } from '../domain/inference.js';
import { VERIFIERS } from '../domain/verify.js';
import { diffFrames, loadObservations } from './diffFrames.js';

export const evidencePackInputSchema = z.object({
  path: z.string().min(1),
  maxFrames: z.number().int().min(1).max(200).optional(),
});

export type EvidencePackInput = z.infer<typeof evidencePackInputSchema>;

export interface PackFrame {
  frameId: string;
  vars: Record<string, number | string | boolean>;
  hex: string;
}

export interface EvidencePack {
  schemaVersion: 1;
  source: SourceEvidence;
  samples: {
    count: number;
    alignedLength: number;
    lengths: number[];
    excludedFrameIds: string[];
    alignment: DiffReport['alignment'] | null;
  };
  fields: FieldCandidate[];
  differential: {
    regions: DiffReport['regions'];
    unknowns: string[];
  };
  checksums: ChecksumCandidate[];
  derived: DerivedField[];
  records: CountField[];
  unknowns: string[];
  frames: PackFrame[];
  framesOmitted: number;
  verifiers: Array<{ name: string; description: string }>;
  notes: string[];
}

export interface AdviseResult {
  pack: EvidencePack;
  evidence: Evidence;
}

export async function buildEvidencePack(input: EvidencePackInput): Promise<AdviseResult> {
  const parsed = evidencePackInputSchema.parse(input);
  const maxFrames = parsed.maxFrames ?? 20;

  const draft = await diffFrames({ path: parsed.path });
  const loaded = await loadObservations(parsed.path);
  const frames = loaded.observations.slice(0, maxFrames).map(toPackFrame);

  const notes = [
    'claims are hypotheses until a listed verifier confirms them against these samples',
    'frames are bounded by maxFrames; framesOmitted reports truncation, so the list is not the whole capture',
    'unknowns are part of the answer: do not silently fill them',
  ];

  const pack: EvidencePack = {
    schemaVersion: 1,
    source: draft.evidence.source,
    samples: {
      count: draft.sampleCount,
      alignedLength: draft.differential.alignedLength,
      lengths: draft.differential.lengths,
      excludedFrameIds: draft.differential.excludedFrameIds,
      alignment: draft.differential.alignment ?? null,
    },
    fields: draft.fields,
    differential: { regions: draft.differential.regions, unknowns: draft.differential.unknowns },
    checksums: draft.checksums,
    derived: draft.derived,
    records: draft.records,
    unknowns: draft.unknowns,
    frames,
    framesOmitted: Math.max(0, loaded.observations.length - frames.length),
    verifiers: VERIFIERS.map((verifier) => ({ name: verifier.name, description: verifier.description })),
    notes,
  };

  return {
    pack,
    evidence: {
      source: draft.evidence.source,
      limitations: notes,
    },
  };
}

function toPackFrame(observation: Observation): PackFrame {
  return {
    frameId: observation.frameId,
    vars: observation.vars,
    hex: observation.bytes.toString('hex'),
  };
}
