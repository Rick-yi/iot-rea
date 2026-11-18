/**
 * Materialize decoded regions. Region paths are validated to stay inside the
 * requested output root; a traversal attempt fails instead of escaping.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IotReaError } from '../../contracts/errors.js';
import type { ArtifactImage } from './types.js';

export interface ExtractedRegion {
  path: string;
  bytes: number;
}

export async function extractRegions(
  image: ArtifactImage,
  outputRoot: string,
): Promise<ExtractedRegion[]> {
  const root = path.resolve(outputRoot);
  const written: ExtractedRegion[] = [];

  for (const [regionPath, bytes] of image.regionBytes) {
    const target = path.resolve(root, regionPath);
    if (!target.startsWith(root + path.sep)) {
      throw new IotReaError('invalid_request', `region path escapes the output root: ${regionPath}`, {
        regionPath,
        outputRoot: root,
      });
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    written.push({ path: target, bytes: bytes.length });
  }

  return written;
}
