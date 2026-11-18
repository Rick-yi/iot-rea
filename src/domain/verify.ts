/**
 * Deterministic verifiers for externally proposed hypotheses.
 *
 * The core never trusts a claim: every verdict comes from recomputing the
 * claim against the supplied samples. Unsupported or unparsable checks yield
 * `unverified`, never a silent pass.
 */
import type { CheckResult, Hypothesis, HypothesisVerdict } from '../contracts/hypotheses.js';
import { checksumCoverageArgsSchema, typeFitArgsSchema } from '../contracts/hypotheses.js';
import type { ChecksumAlgorithm } from './checksum.js';
import { computeChecksum } from './checksum.js';
import type { Observation } from './diff.js';
import type { FieldType } from './inference.js';
import { decodeNumber, matchesDecodedValue } from './inference.js';

export interface VerifierInfo {
  name: string;
  description: string;
  argsSchema: unknown;
}

export const VERIFIERS: VerifierInfo[] = [
  {
    name: 'type_fit',
    description:
      'Recompute a field hypothesis (offset, width, type, endian, optional factor) against labelled samples; verified only when every usable sample matches.',
    argsSchema: typeFitArgsSchema,
  },
  {
    name: 'checksum_coverage',
    description:
      'Recompute a checksum algorithm over a declared coverage range and compare it with the stored bytes at the declared position.',
    argsSchema: checksumCoverageArgsSchema,
  },
];

export function runCheck(check: { verifier: string; args: Record<string, unknown> }, observations: Observation[]): CheckResult {
  switch (check.verifier) {
    case 'type_fit':
      return checkTypeFit(check.args, observations);
    case 'checksum_coverage':
      return checkChecksumCoverage(check.args, observations);
    default:
      return {
        verifier: check.verifier,
        status: 'unsupported',
        matched: 0,
        total: 0,
        counterexamples: [],
        detail: `no verifier named "${check.verifier}" is available`,
      };
  }
}

export function verifyHypothesis(hypothesis: Hypothesis, observations: Observation[]): HypothesisVerdict {
  const checks = hypothesis.checks.map((check) => runCheck(check, observations));

  let status: HypothesisVerdict['status'];
  if (checks.length === 0) {
    status = 'unverified';
  } else if (checks.some((check) => check.status === 'rejected')) {
    status = 'rejected';
  } else if (checks.some((check) => check.status === 'unsupported')) {
    status = 'unverified';
  } else {
    status = 'verified';
  }

  return { id: hypothesis.id, status, claim: hypothesis.claim, checks };
}

export function checkTypeFit(rawArgs: unknown, observations: Observation[]): CheckResult {
  const parsed = typeFitArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return unsupported('type_fit', `invalid type_fit args: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const args = parsed.data;
  let matched = 0;
  let total = 0;
  const counterexamples: string[] = [];

  for (const observation of observations) {
    const expected = expectedNumber(observation.vars[args.variable]);
    if (expected === null) continue;
    total += 1;

    const raw = decodeNumber(args.type as FieldType, args.endian ?? null, observation.bytes, args.offset, args.width);
    if (raw === null) {
      counterexamples.push(observation.frameId);
      continue;
    }
    const value = args.factor === undefined ? raw : raw / args.factor;
    if (matchesDecodedValue(value, expected, args.type)) matched += 1;
    else counterexamples.push(observation.frameId);
  }

  if (total === 0) {
    return unsupported('type_fit', `no sample carries variable "${args.variable}"`);
  }

  return {
    verifier: 'type_fit',
    status: matched === total ? 'verified' : 'rejected',
    matched,
    total,
    counterexamples,
    detail: matched === total ? undefined : `${total - matched} sample(s) contradicted the claim`,
  };
}

export function checkChecksumCoverage(rawArgs: unknown, observations: Observation[]): CheckResult {
  const parsed = checksumCoverageArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return unsupported('checksum_coverage', `invalid checksum_coverage args: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const args = parsed.data;
  if (args.coveredTo < args.coveredFrom) {
    return unsupported('checksum_coverage', 'coveredTo must not be before coveredFrom');
  }

  let matched = 0;
  let total = 0;
  const counterexamples: string[] = [];

  for (const observation of observations) {
    const covered = observation.bytes.subarray(args.coveredFrom, args.coveredTo + 1);
    if (covered.length === 0 || args.position + args.width > observation.bytes.length) {
      counterexamples.push(observation.frameId);
      continue;
    }
    total += 1;
    const expected = computeChecksum(args.algorithm as ChecksumAlgorithm, covered);
    const stored = readStored(observation.bytes, args.position, args.width, args.endian);
    if (stored !== null && stored === expected) matched += 1;
    else counterexamples.push(observation.frameId);
  }

  if (total === 0) {
    return unsupported('checksum_coverage', 'no sample is long enough for the declared position and coverage');
  }

  return {
    verifier: 'checksum_coverage',
    status: matched === total ? 'verified' : 'rejected',
    matched,
    total,
    counterexamples,
    detail: matched === total ? undefined : `${total - matched} sample(s) contradicted the coverage claim`,
  };
}

function expectedNumber(value: number | string | boolean | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readStored(bytes: Buffer, position: number, width: number, endian: 'be' | 'le'): number | null {
  if (position + width > bytes.length) return null;
  switch (width) {
    case 1:
      return bytes[position] ?? null;
    case 2:
      return endian === 'be' ? bytes.readUInt16BE(position) : bytes.readUInt16LE(position);
    case 4:
      return endian === 'be' ? bytes.readUInt32BE(position) : bytes.readUInt32LE(position);
    default:
      return null;
  }
}

function unsupported(verifier: string, detail: string): CheckResult {
  return { verifier, status: 'unsupported', matched: 0, total: 0, counterexamples: [], detail };
}
