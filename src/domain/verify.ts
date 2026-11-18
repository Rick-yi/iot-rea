/**
 * Deterministic verifiers for externally proposed hypotheses.
 *
 * The core never trusts a claim: every verdict comes from recomputing the
 * claim against the supplied samples. Unsupported or unparsable checks yield
 * `unverified`, never a silent pass.
 */
import type { CheckResult, Hypothesis, HypothesisVerdict } from '../contracts/hypotheses.js';
import {
  bcdFitArgsSchema,
  byteTransformArgsSchema,
  checksumCoverageArgsSchema,
  ksyCompileArgsSchema,
  typeFitArgsSchema,
} from '../contracts/hypotheses.js';
import type { ChecksumAlgorithm } from './checksum.js';
import { computeChecksum } from './checksum.js';
import type { Observation } from './diff.js';
import type { FieldType } from './inference.js';
import { decodeNumber, matchesDecodedValue } from './inference.js';

export interface VerifierInfo {
  name: string;
  description: string;
  argsSchema: unknown;
  /** True for verifiers that need I/O or external tools; the app layer runs them. */
  requiresIo?: boolean;
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
  {
    name: 'bcd_fit',
    description:
      'Decode packed BCD (optional byte offset removal, byte reversal and scale) and compare every sample with its label. Invalid nibbles or any mismatch reject the claim.',
    argsSchema: bcdFitArgsSchema,
  },
  {
    name: 'byte_transform',
    description:
      'Apply ordered byte-wise transforms (xor, not, add, bit-reverse, nibble-swap) to the raw bytes, decode as a numeric type, and compare with labels.',
    argsSchema: byteTransformArgsSchema,
  },
  {
    name: 'ksy_compile',
    description:
      'Compile a Kaitai Struct schema with the caller-supplied kaitai-struct-compiler. The generated output is never executed; this checks that the schema is accepted by the compiler.',
    argsSchema: ksyCompileArgsSchema,
    requiresIo: true,
  },
];

export function runCheck(check: { verifier: string; args: Record<string, unknown> }, observations: Observation[]): CheckResult {
  switch (check.verifier) {
    case 'type_fit':
      return checkTypeFit(check.args, observations);
    case 'checksum_coverage':
      return checkChecksumCoverage(check.args, observations);
    case 'bcd_fit':
      return checkBcdFit(check.args, observations);
    case 'byte_transform':
      return checkByteTransform(check.args, observations);
    case 'ksy_compile':
      return {
        verifier: 'ksy_compile',
        status: 'unsupported',
        matched: 0,
        total: 0,
        counterexamples: [],
        detail: 'ksy_compile requires the application verifier (external compiler I/O)',
      };
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
  return verdictFromChecks(hypothesis.id, hypothesis.claim, checks);
}

/** Combine per-check results; rejection dominates, unsupported never passes. */
export function verdictFromChecks(
  id: string,
  claim: string,
  checks: CheckResult[],
): HypothesisVerdict {
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

  return { id, status, claim, checks };
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

const TYPE_WIDTH: Record<string, number> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  f32: 4,
};

export function checkByteTransform(rawArgs: unknown, observations: Observation[]): CheckResult {
  const parsed = byteTransformArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return unsupported('byte_transform', `invalid byte_transform args: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const args = parsed.data;

  if (TYPE_WIDTH[args.type] !== args.width) {
    return unsupported('byte_transform', `type ${args.type} needs width ${TYPE_WIDTH[args.type]}, got ${args.width}`);
  }
  const steps = args.transforms ?? (args.transform === undefined ? [] : [args.transform]);
  if (steps.length === 0) {
    return unsupported('byte_transform', 'provide transform or transforms');
  }
  for (const step of steps) {
    if ((step.kind === 'xor' || step.kind === 'add') && step.operand === undefined) {
      return unsupported('byte_transform', `transform "${step.kind}" requires an operand`);
    }
  }

  let matched = 0;
  let total = 0;
  const counterexamples: string[] = [];

  for (const observation of observations) {
    const expected = expectedNumber(observation.vars[args.variable]);
    if (expected === null) continue;
    total += 1;

    if (args.offset + args.width > observation.bytes.length) {
      counterexamples.push(observation.frameId);
      continue;
    }

    const raw = Buffer.from(observation.bytes.subarray(args.offset, args.offset + args.width));
    let transformed: Buffer = raw;
    for (const step of steps) transformed = transformBytes(transformed, step);
    const decoded = decodeNumber(args.type, args.endian ?? null, transformed, 0, args.width);
    if (decoded === null) {
      counterexamples.push(observation.frameId);
      continue;
    }
    const value = args.factor === undefined ? decoded : decoded / args.factor;
    if (matchesApprox(value, expected)) matched += 1;
    else counterexamples.push(observation.frameId);
  }

  if (total === 0) {
    return unsupported('byte_transform', `no sample carries variable "${args.variable}"`);
  }

  return {
    verifier: 'byte_transform',
    status: matched === total ? 'verified' : 'rejected',
    matched,
    total,
    counterexamples,
    detail: matched === total ? undefined : `${total - matched} sample(s) contradicted the transform claim`,
  };
}

function transformBytes(
  bytes: Buffer,
  transform: { kind: 'xor' | 'not' | 'add' | 'bit-reverse' | 'nibble-swap'; operand?: number },
): Buffer {
  // Chains call this once per step; the output of one step feeds the next.
  return Buffer.from(
    bytes.map((byte) => {
      switch (transform.kind) {
        case 'xor':
          return (byte ^ (transform.operand ?? 0)) & 0xff;
        case 'add':
          // The encoder added the operand; decoding removes it again.
          return (byte - (transform.operand ?? 0)) & 0xff;
        case 'not':
          return (~byte) & 0xff;
        case 'bit-reverse': {
          let value = 0;
          for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | ((byte >> bit) & 1);
          return value & 0xff;
        }
        case 'nibble-swap':
          return ((byte & 0x0f) << 4) | ((byte >> 4) & 0x0f);
      }
    }),
  );
}

export function checkBcdFit(rawArgs: unknown, observations: Observation[]): CheckResult {
  const parsed = bcdFitArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return unsupported('bcd_fit', `invalid bcd_fit args: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const args = parsed.data;
  let matched = 0;
  let total = 0;
  const counterexamples: string[] = [];

  for (const observation of observations) {
    const expected = expectedNumber(observation.vars[args.variable]);
    if (expected === null) continue;
    total += 1;

    if (args.offset + args.width > observation.bytes.length) {
      counterexamples.push(observation.frameId);
      continue;
    }

    let bytes = Buffer.from(observation.bytes.subarray(args.offset, args.offset + args.width));
    if (args.reverseBytes === true) bytes = Buffer.from([...bytes].reverse());
    if (args.byteOffset !== undefined) {
      bytes = Buffer.from(bytes.map((byte) => (byte - (args.byteOffset ?? 0)) & 0xff));
    }

    const digits = decodeBcd(bytes);
    if (digits === null) {
      counterexamples.push(observation.frameId);
      continue;
    }
    const value = args.factor === undefined ? digits : digits / args.factor;
    if (matchesApprox(value, expected)) matched += 1;
    else counterexamples.push(observation.frameId);
  }

  if (total === 0) {
    return unsupported('bcd_fit', `no sample carries variable "${args.variable}"`);
  }

  return {
    verifier: 'bcd_fit',
    status: matched === total ? 'verified' : 'rejected',
    matched,
    total,
    counterexamples,
    detail: matched === total ? undefined : `${total - matched} sample(s) contradicted the BCD claim`,
  };
}

/** Packed BCD, high nibble first; any nibble above 9 is invalid. */
function decodeBcd(bytes: Buffer): number | null {
  let value = 0;
  for (const byte of bytes) {
    const hi = byte >> 4;
    const lo = byte & 0x0f;
    if (hi > 9 || lo > 9) return null;
    value = value * 100 + hi * 10 + lo;
  }
  return value;
}

function matchesApprox(decoded: number, expected: number): boolean {
  return Math.abs(decoded - expected) <= Math.max(1, Math.abs(expected)) * 1e-4;
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
