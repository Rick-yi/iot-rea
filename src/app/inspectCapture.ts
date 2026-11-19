/**
 * inspect-capture: thin workflow over the TShark provider.
 *
 * Keeping argument translation out of the workflow is what lets a later MCP
 * adapter call the same function.
 */
import { z } from 'zod';
import type { Evidence, OutputWindow } from '../contracts/evidence.js';
import { inspectPacketCapture } from '../providers/tshark.js';

export const inspectCaptureInputSchema = z.object({
  path: z.string().min(1),
  fields: z.array(z.string().min(1)).max(1024).optional(),
  displayFilter: z.string().optional(),
  decodeAs: z.array(z.string().min(1)).max(1024).optional(),
  packetLimit: z.number().int().positive().optional(),
  matchOffset: z.number().int().nonnegative().optional(),
  matchLimit: z.number().int().positive().nullable().optional(),
  twoPass: z.boolean().optional(),
  /** Raise the producer output budget for large result sets (bytes). */
  maxOutputBytes: z.number().int().positive().optional(),
});

export type InspectCaptureInput = z.infer<typeof inspectCaptureInputSchema>;

export interface InspectCaptureOutput {
  rows: Array<{ frameNumber: number; fields: Record<string, string | string[]> }>;
  window: OutputWindow;
  columns: string[];
  evidence: Evidence;
}

export async function inspectCapture(input: InspectCaptureInput): Promise<InspectCaptureOutput> {
  const parsed = inspectCaptureInputSchema.parse(input);
  const fields = parsed.fields ?? ['frame.number'];

  const page = await inspectPacketCapture({
    path: parsed.path,
    fields,
    displayFilter: parsed.displayFilter,
    decodeAs: parsed.decodeAs,
    packetLimit: parsed.packetLimit,
    matchOffset: parsed.matchOffset,
    matchLimit: parsed.matchLimit,
    twoPass: parsed.twoPass,
    maxOutputBytes: parsed.maxOutputBytes,
  });

  return {
    rows: page.rows,
    window: page.window,
    columns: [...fields],
    evidence: page.evidence,
  };
}
