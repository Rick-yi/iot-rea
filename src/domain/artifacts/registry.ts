/**
 * Format sniffing. Recognition is signature-first and strict; the file name is
 * never trusted. An unrecognized file returns an explicit unknown inventory so
 * callers cannot mistake a fallback for a decoded artifact.
 */
import type { ArtifactImage, ArtifactFormat } from './types.js';
import { inspectDfuSe, isDfuSe } from './dfuse.js';
import { inspectIntelHex, isIntelHex } from './hexrecords.js';
import { inspectSrec, isSrec } from './srec.js';
import { inspectUf2, isUf2 } from './uf2.js';

export function sniffFormat(bytes: Buffer): ArtifactFormat {
  if (isUf2(bytes)) return 'uf2';
  if (isDfuSe(bytes)) return 'dfuse';
  if (isIntelHex(bytes)) return 'intel-hex';
  if (isSrec(bytes)) return 'srec';
  return 'unknown';
}

export function inspectArtifactBytes(bytes: Buffer): ArtifactImage {
  switch (sniffFormat(bytes)) {
    case 'uf2':
      return inspectUf2(bytes);
    case 'dfuse':
      return inspectDfuSe(bytes);
    case 'intel-hex':
      return inspectIntelHex(bytes);
    case 'srec':
      return inspectSrec(bytes);
    case 'unknown':
      return {
        inventory: {
          format: 'unknown',
          size: bytes.length,
          regions: [],
          metadata: {},
          unknowns: ['no supported container signature matched; bytes were not decoded'],
        },
        regionBytes: new Map(),
      };
  }
}
