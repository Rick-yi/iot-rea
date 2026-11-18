/**
 * Intel HEX (I8HEX / I16HEX / I32HEX) inventory.
 *
 * Recognition is strict: the first line, starting at byte 0, must be a fully
 * valid record. A BOM, a blank first line or a bad checksum leaves the file
 * unrecognized rather than scanning forward for a record.
 */
import type { ArtifactImage, ArtifactInventory } from './types.js';
import { regionName } from './types.js';

export interface HexRecord {
  lineNo: number;
  type: number;
  address: number;
  data: Buffer;
}

const RECORD_DATA = 0x00;
const RECORD_EOF = 0x01;
const RECORD_EXT_SEGMENT = 0x02;
const RECORD_START_SEGMENT = 0x03;
const RECORD_EXT_LINEAR = 0x04;
const RECORD_START_LINEAR = 0x05;

export function parseIntelHexRecord(line: string, lineNo: number): HexRecord | null {
  if (!line.startsWith(':')) return null;
  if (line.length < 11 || (line.length - 1) % 2 !== 0) return null;
  if (!/^:[0-9A-Fa-f]+$/.test(line)) return null;

  const body = line.slice(1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 2) {
    bytes.push(Number.parseInt(body.slice(index, index + 2), 16));
  }

  const length = bytes[0];
  if (length === undefined) return null;
  if (bytes.length !== length + 5) return null;

  const checksum = bytes[bytes.length - 1];
  if (checksum === undefined) return null;
  const sum = bytes.reduce((acc, byte) => (acc + byte) & 0xff, 0);
  if (sum !== 0) return null;

  const type = bytes[3] ?? -1;
  const address = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  const data = Buffer.from(bytes.slice(4, 4 + length));

  return { lineNo, type, address, data };
}

export function isIntelHex(bytes: Buffer): boolean {
  const first = firstLine(bytes);
  if (first === null) return false;
  return parseIntelHexRecord(first, 1) !== null;
}

export function inspectIntelHex(bytes: Buffer): ArtifactImage {
  const text = bytes.toString('ascii');
  const lines = text.split(/\r?\n/);
  const first = parseIntelHexRecord(lines[0] ?? '', 1);
  if (first === null) {
    throw new Error('not an Intel HEX image: first line is not a valid record');
  }

  const addressBytes = new Map<number, number>();
  const recordTypes = new Set<number>();
  const unknowns: string[] = [];
  let recordCount = 0;
  let dataRecordCount = 0;
  let duplicateBytes = 0;
  let base = 0;
  let terminated = false;
  let startAddress: number | null = null;
  let startAddressRecord: number | null = null;
  let startSegmentCs: number | null = null;
  let startSegmentIp: number | null = null;
  let sawSegmentBase = false;
  let sawLinearBase = false;

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const record = parseIntelHexRecord(trimmed, index + 1);
    if (record === null) {
      unknowns.push(`line ${index + 1} is not a valid Intel HEX record; it was ignored`);
      continue;
    }
    recordCount += 1;
    recordTypes.add(record.type);

    if (record.type === RECORD_DATA) {
      dataRecordCount += 1;
      for (let offset = 0; offset < record.data.length; offset += 1) {
        const address = base + record.address + offset;
        if (addressBytes.has(address)) duplicateBytes += 1;
        addressBytes.set(address, record.data[offset] ?? 0);
      }
      continue;
    }

    if (record.type === RECORD_EOF) {
      terminated = true;
      if (lines.slice(index + 1).some((rest) => rest.trim() !== '')) {
        unknowns.push('records follow the EOF record; they were not decoded');
      }
      break;
    }

    if (record.type === RECORD_EXT_SEGMENT) {
      sawSegmentBase = true;
      const value = ((record.data[0] ?? 0) << 8) | (record.data[1] ?? 0);
      base = value << 4;
      continue;
    }

    if (record.type === RECORD_EXT_LINEAR) {
      sawLinearBase = true;
      const value =
        ((record.data[0] ?? 0) << 24) |
        ((record.data[1] ?? 0) << 16) |
        ((record.data[2] ?? 0) << 8) |
        (record.data[3] ?? 0);
      base = value * 0x10000;
      continue;
    }

    if (record.type === RECORD_START_SEGMENT) {
      startAddressRecord = RECORD_START_SEGMENT;
      startSegmentCs = ((record.data[0] ?? 0) << 8) | (record.data[1] ?? 0);
      startSegmentIp = ((record.data[2] ?? 0) << 8) | (record.data[3] ?? 0);
      startAddress = (startSegmentCs << 4) + startSegmentIp;
      continue;
    }

    if (record.type === RECORD_START_LINEAR) {
      startAddressRecord = RECORD_START_LINEAR;
      startAddress =
        ((record.data[0] ?? 0) << 24) |
        ((record.data[1] ?? 0) << 16) |
        ((record.data[2] ?? 0) << 8) |
        (record.data[3] ?? 0);
    }
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

  const variant = sawSegmentBase && sawLinearBase
    ? 'mixed'
    : sawLinearBase
      ? 'i32hex'
      : sawSegmentBase
        ? 'i16hex'
        : 'i8hex';

  return {
    inventory: {
      format: 'intel-hex',
      size: bytes.length,
      regions,
      metadata: {
        encoding: 'intel-hex',
        variant,
        lineCount: lines.filter((line) => line.trim() !== '').length,
        recordCount,
        dataRecordCount,
        dataBytes: addressBytes.size,
        duplicateBytes,
        regionCount: regions.length,
        lowestAddress: addresses[0] ?? null,
        highestAddress: addresses[addresses.length - 1] ?? null,
        termination: terminated ? 'eof' : null,
        startAddress,
        startAddressRecord,
        startSegmentCs,
        startSegmentIp,
        recordTypes: [...recordTypes],
      },
      unknowns,
    },
    regionBytes,
  };
}

function firstLine(bytes: Buffer): string | null {
  const text = bytes.toString('ascii');
  const newline = text.search(/\r?\n/);
  const line = newline === -1 ? text : text.slice(0, newline);
  return line === '' ? null : line;
}
