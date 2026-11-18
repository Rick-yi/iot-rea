/**
 * Checksum candidates over the frames in a run.
 *
 * A candidate is accepted only when it reproduces every usable frame; a
 * partial match is reported at low confidence together with its counterexample.
 */
import type { Observation } from './diff.js';

export type ChecksumAlgorithm =
  | 'sum8'
  | 'sum16'
  | 'xor8'
  | 'crc16-ccitt-false'
  | 'crc16-modbus'
  | 'crc32';

export interface ChecksumCandidate {
  algorithm: ChecksumAlgorithm;
  /** Offset of the stored checksum. */
  position: number;
  width: number;
  /** Stored byte order observed for the checksum. */
  endian: 'be' | 'le';
  coveredFrom: number;
  coveredTo: number;
  matched: number;
  total: number;
  confidence: number;
  /** Frame ids that did not reproduce the checksum. */
  counterexamples: string[];
}

export interface ChecksumReport {
  candidates: ChecksumCandidate[];
  unknowns: string[];
}

const ALGORITHMS: Array<{ name: ChecksumAlgorithm; width: number; compute: (bytes: Buffer) => number }> = [
  { name: 'sum8', width: 1, compute: (bytes) => bytes.reduce((acc, byte) => (acc + byte) & 0xff, 0) },
  { name: 'xor8', width: 1, compute: (bytes) => bytes.reduce((acc, byte) => acc ^ byte, 0) },
  { name: 'sum16', width: 2, compute: (bytes) => bytes.reduce((acc, byte) => (acc + byte) & 0xffff, 0) },
  { name: 'crc16-ccitt-false', width: 2, compute: (bytes) => crc16Ccitt(bytes) },
  { name: 'crc16-modbus', width: 2, compute: (bytes) => crc16Modbus(bytes) },
  { name: 'crc32', width: 4, compute: (bytes) => crc32(bytes) },
];

export function checksumCandidates(observations: Observation[]): ChecksumReport {
  const usable = observations.filter((obs) => obs.bytes.length >= 4);
  if (usable.length < 2) {
    return {
      candidates: [],
      unknowns: ['checksum scoring needs at least two frames of four bytes or more'],
    };
  }

  const candidates: ChecksumCandidate[] = [];
  const lengths = new Set(usable.map((obs) => obs.bytes.length));

  for (const position of [Math.min(...lengths) - 1, Math.min(...lengths) - 2]) {
    for (const algorithm of ALGORITHMS) {
      if (position - algorithm.width + 1 < 0) continue;
      const byteOrders: Array<'be' | 'le'> = algorithm.width === 1 ? ['be'] : ['be', 'le'];
      for (const endian of byteOrders) {
        const coveredFrom = 0;
        const coveredTo = position - 1;
        if (coveredTo - coveredFrom + 1 <= 0) continue;

        const counterexamples: string[] = [];
        for (const obs of usable) {
          if (position + algorithm.width > obs.bytes.length) {
            counterexamples.push(obs.frameId);
            continue;
          }
          const expected = algorithm.compute(obs.bytes.subarray(coveredFrom, position));
          const stored = readStored(obs.bytes, position, algorithm.width, endian);
          if (expected !== stored) counterexamples.push(obs.frameId);
        }

        const matched = usable.length - counterexamples.length;
        const confidence = matched / usable.length;
        if (confidence < 0.5) continue;

        candidates.push({
          algorithm: algorithm.name,
          position,
          width: algorithm.width,
          endian,
          coveredFrom,
          coveredTo,
          matched,
          total: usable.length,
          confidence,
          counterexamples,
        });
      }
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.width - b.width);
  const top = candidates[0];

  if (top === undefined) {
    return {
      candidates: [],
      unknowns: ['no checksum algorithm reproduced the supplied frames'],
    };
  }

  return {
    candidates: candidates.filter((candidate) => candidate.confidence >= top.confidence),
    unknowns: [],
  };
}

function readStored(bytes: Buffer, position: number, width: number, endian: 'be' | 'le'): number | null {
  if (position + width > bytes.length) return null;
  switch (width) {
    case 1:
      return bytes[position] ?? null;
    case 2:
      return endian === 'be' ? bytes.readUInt16BE(position) : bytes.readUInt16LE(position);
    case 4:
      return endian === 'be' ? bytes.readUInt32BE(position) : bytes.readUInt32LE(position);
    default:
      return null;
  }
}

export function crc16Ccitt(bytes: Buffer): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function crc16Modbus(bytes: Buffer): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) & 0xffff : crc >>> 1;
    }
  }
  return crc;
}

export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
