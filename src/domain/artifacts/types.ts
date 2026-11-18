/**
 * Shared artifact inventory vocabulary.
 *
 * Regions are address-contiguous runs of decoded bytes. Gaps are never filled,
 * and a region name encodes its inclusive address bounds so comparisons stay
 * meaningful without reading the bytes.
 */
export type ArtifactFormat = 'uf2' | 'dfuse' | 'intel-hex' | 'srec' | 'unknown';

export interface ArtifactRegion {
  /** Logical path inside the artifact, e.g. "family-0xe48bff56/0x10000000-0x1000001f.bin". */
  path: string;
  startAddress: number | null;
  /** Inclusive end address. */
  endAddress: number | null;
  length: number;
  metadata: Record<string, unknown>;
}

export interface ArtifactInventory {
  format: ArtifactFormat;
  size: number;
  regions: ArtifactRegion[];
  metadata: Record<string, unknown>;
  unknowns: string[];
}

export interface ArtifactImage {
  inventory: ArtifactInventory;
  /** Decoded bytes per region path; empty for opaque containers. */
  regionBytes: Map<string, Buffer>;
}

export interface AddressBlock {
  address: number;
  data: Buffer;
}

/** Merge address-ordered blocks into contiguous regions; gaps split them. */
export function mergeAddressBlocks(blocks: AddressBlock[]): Array<{ start: number; end: number; data: Buffer }> {
  const sorted = [...blocks].sort((a, b) => a.address - b.address);
  const merged: Array<{ start: number; end: number; data: Buffer }> = [];

  for (const block of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && block.address === last.end + 1) {
      last.data = Buffer.concat([last.data, block.data]);
      last.end = block.address + block.data.length - 1;
      continue;
    }
    if (last !== undefined && block.address <= last.end) {
      // Overlap: keep the first bytes and record the overlap as duplicate data.
      const overlap = last.end - block.address + 1;
      const remainder = block.data.subarray(overlap);
      last.data = Buffer.concat([last.data, remainder]);
      last.end = last.end + remainder.length;
      continue;
    }
    merged.push({
      start: block.address,
      end: block.address + block.data.length - 1,
      data: block.data,
    });
  }

  return merged;
}

export function regionName(start: number, end: number, prefix?: string): string {
  const bounds = `0x${start.toString(16).padStart(8, '0')}-0x${end.toString(16).padStart(8, '0')}.bin`;
  return prefix === undefined ? bounds : `${prefix}/${bounds}`;
}
