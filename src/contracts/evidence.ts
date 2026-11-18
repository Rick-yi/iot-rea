/**
 * Evidence is the only carrier of conclusions in iot-rea.
 *
 * Four categories are never mixed:
 *   observation  - what the producer printed or the file contained
 *   derivation   - deterministic computation over observations (digest, offsets)
 *   inference    - a scored hypothesis (field type, checksum algorithm)
 *   unknown      - something the run could not establish
 *
 * An empty result is an observation about the selected window only. It never
 * establishes absence outside that window, filter or recording.
 */
import { z } from 'zod';

export const sourceEvidenceSchema = z.object({
  path: z.string(),
  sha256: z.string().length(64),
  size: z.number().int().nonnegative(),
});

export const toolEvidenceSchema = z.object({
  configuredPath: z.string().nullable(),
  resolvedPath: z.string(),
  versionBanner: z.string().nullable(),
  sha256: z.string().length(64).nullable(),
});

export const outputWindowSchema = z.object({
  offset: z.number().int().nonnegative(),
  requestedLimit: z.number().int().positive().nullable(),
  total: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export const evidenceSchema = z.object({
  source: sourceEvidenceSchema,
  tool: toolEvidenceSchema.optional(),
  argv: z.array(z.string()).optional(),
  stderr: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  window: outputWindowSchema.optional(),
  limitations: z.array(z.string()).optional(),
});

export type SourceEvidence = z.infer<typeof sourceEvidenceSchema>;
export type ToolEvidence = z.infer<typeof toolEvidenceSchema>;
export type OutputWindow = z.infer<typeof outputWindowSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

/** Producer text kept verbatim; never parsed into protocol facts. */
export interface CapturedOutput<T> {
  data: T;
  evidence: Evidence;
}

export function emptyWindow(total: number, offset: number, limit: number | null): OutputWindow {
  return { offset, requestedLimit: limit, total, returned: 0, hasMore: total > offset };
}
