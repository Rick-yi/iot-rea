/**
 * inspect-firmware: static container inventory.
 *
 * No extraction tool, mount, emulation or execution is involved. Bytes flow
 * through a pure parser, and the result carries the source digest.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Evidence } from '../contracts/evidence.js';
import type { ArtifactInventory } from '../domain/artifacts/types.js';
import { inspectArtifactBytes } from '../domain/artifacts/registry.js';
import { extractRegions, type ExtractedRegion } from '../domain/artifacts/extract.js';
import { DEFAULT_MAX_INPUT_BYTES, fileSize, sha256File } from '../providers/process.js';
import { IotReaError } from '../contracts/errors.js';

export const inspectFirmwareInputSchema = z.object({
  path: z.string().min(1),
  extractTo: z.string().min(1).optional(),
});

export type InspectFirmwareInput = z.infer<typeof inspectFirmwareInputSchema>;

export interface InspectFirmwareOutput {
  inventory: ArtifactInventory;
  extracted: ExtractedRegion[];
  evidence: Evidence;
}

export async function inspectFirmware(input: InspectFirmwareInput): Promise<InspectFirmwareOutput> {
  const parsed = inspectFirmwareInputSchema.parse(input);
  const size = await fileSize(parsed.path);
  if (size > DEFAULT_MAX_INPUT_BYTES) {
    throw new IotReaError('input_limit', `artifact is ${size} bytes, limit is ${DEFAULT_MAX_INPUT_BYTES}`, {
      size,
      limitBytes: DEFAULT_MAX_INPUT_BYTES,
    });
  }

  const digest = await sha256File(parsed.path);
  let bytes: Buffer;
  try {
    bytes = await readFile(parsed.path);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `cannot read ${parsed.path}: ${message}`, {
      path: parsed.path,
    });
  }

  const image = inspectArtifactBytes(bytes);
  const extracted =
    parsed.extractTo === undefined
      ? []
      : await extractRegions(image, parsed.extractTo);

  return {
    inventory: image.inventory,
    extracted,
    evidence: {
      source: { path: parsed.path, sha256: digest, size },
      limitations: [
        ...image.inventory.unknowns,
        'container parsing is static; it does not establish runtime behavior or CPU state',
        'extracted bytes were not executed or emulated',
      ],
    },
  };
}
