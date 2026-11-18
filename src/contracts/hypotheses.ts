/**
 * Advisor seam: a wire contract for hypotheses proposed outside the core.
 *
 * The core never calls a model. It only accepts claims in this shape and
 * answers with a deterministic verdict. A model (or a human) can therefore sit
 * outside this repository without becoming a source of facts.
 */
import { z } from 'zod';

export const verificationKindSchema = z.enum(['type_fit', 'checksum_coverage', 'bcd_fit', 'byte_transform']);
export type VerificationKind = z.infer<typeof verificationKindSchema>;

export const hypothesisKindSchema = z.enum([
  'field_semantics',
  'scaling',
  'checksum',
  'experiment',
  'state_transition',
  'codec',
  'other',
]);
export type HypothesisKind = z.infer<typeof hypothesisKindSchema>;

export const proposedBySchema = z.object({
  source: z.enum(['human', 'llm', 'tool']),
  model: z.string().optional(),
  promptSha256: z.string().length(64).optional(),
});
export type ProposedBy = z.infer<typeof proposedBySchema>;

export const fieldTypeSchema = z.enum(['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32', 'bcd2']);

export const typeFitArgsSchema = z.object({
  offset: z.number().int().nonnegative(),
  width: z.number().int().min(1).max(8),
  type: fieldTypeSchema,
  endian: z.enum(['be', 'le']).nullable().optional(),
  variable: z.string().min(1),
  /** Optional linear scale: expected = decoded / factor. */
  factor: z.number().positive().optional(),
});
export type TypeFitArgs = z.infer<typeof typeFitArgsSchema>;

export const bcdFitArgsSchema = z.object({
  offset: z.number().int().nonnegative(),
  // 6 bytes = 12 decimal digits, still exact in a JS number.
  width: z.number().int().min(1).max(6),
  variable: z.string().min(1),
  /**
   * Byte-wise offset removed before BCD decoding. `byteOffset: 0x33` means
   * the wire bytes were produced by adding 0x33 to each decoded byte.
   */
  byteOffset: z.number().int().min(-255).max(255).optional(),
  /** Reverse byte order after removing byteOffset, for little-endian digit order. */
  reverseBytes: z.boolean().optional(),
  /** Optional scale: expected = decodedDigits / factor, e.g. factor 100 for 12.34. */
  factor: z.number().positive().optional(),
});
export type BcdFitArgs = z.infer<typeof bcdFitArgsSchema>;

export const numericFieldTypeSchema = z.enum(['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32']);

export const byteTransformArgsSchema = z.object({
  offset: z.number().int().nonnegative(),
  width: z.number().int().min(1).max(8),
  variable: z.string().min(1),
  type: numericFieldTypeSchema,
  endian: z.enum(['be', 'le']).nullable().optional(),
  /**
   * One byte-wise transform applied before numeric decoding.
   * Chains are not expressible in v1; the raw bytes are always the input.
   */
  transform: z.object({
    kind: z.enum(['xor', 'not', 'add', 'bit-reverse', 'nibble-swap']),
    /**
     * Required for xor and add; ignored by the others. `add` means the wire
     * bytes had the operand added, so verification subtracts it back.
     */
    operand: z.number().int().min(0).max(255).optional(),
  }),
  /** Optional scale: expected = decoded / factor. */
  factor: z.number().positive().optional(),
});
export type ByteTransformArgs = z.infer<typeof byteTransformArgsSchema>;

export const checksumCoverageArgsSchema = z.object({
  algorithm: z.enum(['sum8', 'xor8', 'sum16', 'crc16-ccitt-false', 'crc16-modbus', 'crc32']),
  position: z.number().int().nonnegative(),
  width: z.number().int().min(1).max(4),
  endian: z.enum(['be', 'le']),
  coveredFrom: z.number().int().nonnegative(),
  coveredTo: z.number().int().nonnegative(),
});
export type ChecksumCoverageArgs = z.infer<typeof checksumCoverageArgsSchema>;

export const checkSchema = z.object({
  // Kept as a free string so an unknown verifier yields `unsupported` instead
  // of rejecting the whole file; new verifiers can land without breaking callers.
  verifier: z.string().min(1),
  args: z.record(z.unknown()),
});
export type Check = z.infer<typeof checkSchema>;

export const hypothesisSchema = z.object({
  id: z.string().min(1),
  kind: hypothesisKindSchema,
  claim: z.string().min(1),
  proposedBy: proposedBySchema.optional(),
  evidenceRefs: z.array(z.string()).default([]),
  /** At least one deterministic check is required; a claim with no check stays unverified. */
  checks: z.array(checkSchema).default([]),
});
export type Hypothesis = z.infer<typeof hypothesisSchema>;

export const hypothesisFileSchema = z.union([
  z.array(hypothesisSchema),
  z.object({ hypotheses: z.array(hypothesisSchema) }),
]);
export type HypothesisFile = z.infer<typeof hypothesisFileSchema>;

export interface CheckResult {
  verifier: string;
  status: 'verified' | 'rejected' | 'unsupported';
  matched: number;
  total: number;
  counterexamples: string[];
  detail?: string;
}

export interface HypothesisVerdict {
  id: string;
  status: 'verified' | 'rejected' | 'unverified';
  claim: string;
  checks: CheckResult[];
}
