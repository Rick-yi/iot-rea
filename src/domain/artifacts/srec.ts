/**
 * Motorola S-record (S19 / S28 / S37) inventory.
 *
 * Recognition is strict in the same way as Intel HEX: the first line at byte 0
 * must be a fully valid record.
 */
import type { ArtifactImage, ArtifactInventory } from './types.js';
import { regionName } from './types.js';

export interface SrecRecord {
  lineNo: number;
  type: string;
  address: number;
  data: Buffer;
}

const ADDRESS_WIDTH: Record<string, number> = {
  S0: 2,
  S1: 2,
  S2: 3,
  S3: 4,
  S5: 2,
  S6: 3,
  S7: 4,
  S8: 3,
  S9: 2,
};

export function parseSrecRecord(line: string, lineNo: number): SrecRecord | null {
  if (!/^S[0-9]$/.test(line.slice(0, 2))) return null;
  const type = line.slice(0, 2);
  const addressWidth = ADDRESS_WIDTH[type];
  if (addressWidth === undefined) return null;
  if (!/^S[0-9][0-9A-Fa-f]+$/.test(line)) return null;
  if (line.length < 4 + addressWidth * 2 + 2) return null;

  const count = Number.parseInt(line.slice(2, 4), 16);
  if (line.length !== 4 + count * 2) return null;

  const bytes: number[] = [];
  for (let index = 2; index < line.length; index += 2) {
    bytes.push(Number.parseInt(line.slice(index, index + 2), 16));
  }
  const sum = bytes.reduce((acc, byte) => (acc + byte) & 0xff, 0);
  if (sum !== 0xff) return null;

  const addressHex = line.slice(4, 4 + addressWidth * 2);
  const address = Number.parseInt(addressHex, 16);
  const dataStart = 4 + addressWidth * 2;
  const data = Buffer.from(line.slice(dataStart, line.length - 2).match(/../g)?.map((pair) => Number.parseInt(pair, 16)) ?? []);

  return { lineNo, type, address, data };
}

export function isSrec(bytes: Buffer): boolean {
  const text = bytes.toString('ascii');
  const first = text.split(/\r?\n/)[0];
  if (first === undefined || first === '') return false;
  return parseSrecRecord(first, 1) !== null;
}

export function inspectSrec(bytes: Buffer): ArtifactImage {
  const text = bytes.toString('ascii');
  const lines = text.split(/\r?\n/);
  const first = parseSrecRecord(lines[0] ?? '', 1);
  if (first === null) throw new Error('not an S-record image: first line is not a valid record');

  const addressBytes = new Map<number, number>();
  const types = new Set<string>();
  const unknowns: string[] = [];
  let recordCount = 0;
  let dataRecordCount = 0;
  let duplicateBytes = 0;
  let termination: string | null = null;
  let startAddress: number | null = null;
  let headerHex: string | null = null;
  let headerText: string | null = null;

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const record = parseSrecRecord(trimmed, index + 1);
    if (record === null) {
      unknowns.push(`line ${index + 1} is not a valid S-record; it was ignored`);
      continue;
    }
    recordCount += 1;
    types.add(record.type);

    if (record.type === 'S0') {
      headerHex = record.data.toString('hex');
      const printable = record.data.every((byte) => byte >= 0x20 && byte <= 0x7e);
      headerText = printable ? record.data.toString('ascii') : null;
      continue;
    }

    if (record.type === 'S1' || record.type === 'S2' || record.type === 'S3') {
      dataRecordCount += 1;
      for (let offset = 0; offset < record.data.length; offset += 1) {
        const address = record.address + offset;
        if (addressBytes.has(address)) duplicateBytes += 1;
        addressBytes.set(address, record.data[offset] ?? 0);
      }
      continue;
    }

    if (record.type === 'S7' || record.type === 'S8' || record.type === 'S9') {
      termination = record.type;
      startAddress = record.address;
      continue;
    }

    if (record.type === 'S5' || record.type === 'S6') {
      // record count records carry no payload data
      continue;
    }

    unknowns.push(`record type ${record.type} is not decoded in v1`);
  }

  const regions: ArtifactInventory['regions'] = [];
  const regionBytes = new Map<string, Buffer>();
  const addresses = [...addressBytes.keys()].sort((a, b) => a - b);

  if (addresses.length > 0) {
    let runStart = addresses[0] as number;
    let previous = runStart;
    const chunks: Array<{ start: number; end: number; data: Buffer }> = [];
    let current = Buffer.from([addressBytes.get(runStart) ?? 0]);

    for (const address of addresses.slice(1)) {
      if (address === previous + 1) {
        current = Buffer.concat([current, Buffer.from([addressBytes.get(address) ?? 0])]);
        previous = address;
        continue;
      }
      chunks.push({ start: runStart, end: previous, data: current });
      runStart = address;
      previous = address;
      current = Buffer.from([addressBytes.get(address) ?? 0]);
    }
    chunks.push({ start: runStart, end: previous, data: current });

    for (const chunk of chunks) {
      const path = regionName(chunk.start, chunk.end);
      regions.push({
        path,
        startAddress: chunk.start,
        endAddress: chunk.end,
        length: chunk.data.length,
        metadata: { startAddress: chunk.start, endAddress: chunk.end, length: chunk.data.length },
      });
      regionBytes.set(path, chunk.data);
    }
  }

  const variant = types.has('S3') || types.has('S7')
    ? 's37'
    : types.has('S2') || types.has('S8')
      ? 's28'
      : 's19';

  return {
    inventory: {
      format: 'srec',
      size: bytes.length,
      regions,
      metadata: {
        encoding: 'srec',
        variant,
        lineCount: lines.filter((line) => line.trim() !== '').length,
        recordCount,
        dataRecordCount,
        dataBytes: addressBytes.size,
        duplicateBytes,
        regionCount: regions.length,
        lowestAddress: addresses[0] ?? null,
        highestAddress: addresses[addresses.length - 1] ?? null,
        termination,
        startAddress,
        headerHex,
        headerText,
        recordTypes: [...types],
      },
      unknowns,
    },
    regionBytes,
  };
}
