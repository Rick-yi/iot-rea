/**
 * DfuSe (ST DFU update container) identification.
 *
 * v1 deliberately keeps the target layout opaque. The header signature and the
 * 16-byte DFU 1.1a suffix are verified; anything beyond that is reported as an
 * unknown rather than guessed from undocumented offsets.
 */
import type { ArtifactImage, ArtifactInventory } from './types.js';

const DFU_SIGNATURE = 'DfuSe';
const DFU_BCDFU = 0x011a;
const DFU_SUFFIX_LENGTH = 16;

export interface DfuSuffix {
  bcdDevice: number;
  idProduct: number;
  idVendor: number;
  bcdDFU: number;
  signature: string;
  bLength: number;
  crc: number;
}

export function parseDfuSuffix(bytes: Buffer): DfuSuffix | null {
  if (bytes.length < DFU_SUFFIX_LENGTH) return null;
  const start = bytes.length - DFU_SUFFIX_LENGTH;
  const bLength = bytes[start + 11];
  if (bLength !== DFU_SUFFIX_LENGTH) return null;
  const signature = bytes.toString('ascii', start + 8, start + 11);
  if (signature !== 'UFD') return null;
  const bcdDFU = bytes.readUInt16LE(start + 6);
  if (bcdDFU !== DFU_BCDFU) return null;

  return {
    bcdDevice: bytes.readUInt16LE(start),
    idProduct: bytes.readUInt16LE(start + 2),
    idVendor: bytes.readUInt16LE(start + 4),
    bcdDFU,
    signature,
    bLength,
    crc: bytes.readUInt32LE(start + 12),
  };
}

export function isDfuSe(bytes: Buffer): boolean {
  if (bytes.length < 11 + DFU_SUFFIX_LENGTH) return false;
  if (bytes.toString('ascii', 0, 5) !== DFU_SIGNATURE) return false;
  const version = bytes[5];
  if (version !== 1) return false;
  return parseDfuSuffix(bytes) !== null;
}

export function inspectDfuSe(bytes: Buffer): ArtifactImage {
  const suffix = parseDfuSuffix(bytes);
  const version = bytes[5] ?? null;

  const inventory: ArtifactInventory = {
    format: 'dfuse',
    size: bytes.length,
    regions: [],
    metadata: {
      signature: DFU_SIGNATURE,
      version,
      suffix,
      bodyBytes: bytes.length - 12 - DFU_SUFFIX_LENGTH,
    },
    unknowns: [
      'DfuSe target and element descriptors are not parsed in v1; the container is retained verbatim',
      'suffix dwCRC is recorded but not independently verified',
    ],
  };

  return { inventory, regionBytes: new Map() };
}
