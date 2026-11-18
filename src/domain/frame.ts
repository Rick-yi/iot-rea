/**
 * One normalized frame vocabulary for every capture source.
 *
 * pcap rows, serial recordings and decoded logic signals all land here, so the
 * diff engine never needs to know where the bytes came from.
 */
export type Direction = 'tx' | 'rx' | 'in' | 'out' | 'unknown';

export interface Frame {
  /** Stable index within the run, starting at 1. */
  index: number;
  /** Producer-native identity: frame number, log line, annotation range. */
  nativeId: string;
  timestampMs: number | null;
  direction: Direction;
  channel: string;
  bytes: Buffer;
}

export interface FrameRow {
  index: number;
  nativeId: string;
  timestampMs: number | null;
  direction: Direction;
  channel: string;
  length: number;
  hex: string;
}

export function toHex(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('hex').replace(/(..)(?=.)/g, '$1 ');
}

/** Accepts "01 03 00 00", "01:03:00:00", "01030000" and mixed separators. */
export function parseHex(text: string): Buffer | null {
  const cleaned = text.trim().replace(/0x/gi, '');
  if (cleaned === '') return null;

  const tokens = cleaned.split(/[\s,;:|/-]+/).filter((token) => token !== '');
  if (tokens.length === 0) return null;
  for (const token of tokens) {
    if (!/^[0-9a-fA-F]+$/.test(token) || token.length % 2 !== 0) return null;
  }

  const hex = tokens.join('');
  if (hex.length % 2 !== 0) return null;
  return Buffer.from(hex, 'hex');
}

export function toRow(frame: Frame): FrameRow {
  return {
    index: frame.index,
    nativeId: frame.nativeId,
    timestampMs: frame.timestampMs,
    direction: frame.direction,
    channel: frame.channel,
    length: frame.bytes.length,
    hex: toHex(frame.bytes),
  };
}
