/**
 * Recorded serial log adapter (no hardware access).
 *
 * Accepted shapes:
 *   [2026-11-18T10:00:00.123Z] TX 01 03 00 00
 *   10:00:00.123 RX 01 03 04 00 0A
 *   TX 01 03 00 00
 *   01 03 00 00            (direction unknown)
 *   {"ts":1690000000.1,"dir":"tx","channel":"uart0","hex":"01030000"}   (JSONL)
 *
 * A line that cannot be parsed is reported as unknown and counted, never
 * silently dropped.
 */
import { readFile } from 'node:fs/promises';
import type { Frame, Direction } from '../domain/frame.js';
import { parseHex, toRow } from '../domain/frame.js';
import type { Evidence } from '../contracts/evidence.js';
import { IotReaError } from '../contracts/errors.js';
import { DEFAULT_MAX_INPUT_BYTES, fileSize, sha256File } from './process.js';
import type { FrameRow } from '../domain/frame.js';

export interface SerialLog {
  frames: Frame[];
  rows: FrameRow[];
  skippedLines: number;
  evidence: Evidence;
}

export function parseSerialLine(line: string, lineNo: number): Frame | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  if (trimmed.startsWith('{')) {
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      const hex = typeof value['hex'] === 'string' ? value['hex'] : null;
      const bytes = hex === null ? null : parseHex(hex);
      if (bytes === null) return null;
      return {
        index: lineNo,
        nativeId: `line:${lineNo}`,
        timestampMs: toTimestampMs(value['ts']),
        direction: toDirection(value['dir']),
        channel: typeof value['channel'] === 'string' ? value['channel'] : 'serial',
        bytes,
      };
    } catch {
      return null;
    }
  }

  let rest = trimmed;
  let timestampMs: number | null = null;

  const bracket = rest.match(/^\[([^\]]+)\]\s*/);
  if (bracket !== null) {
    timestampMs = toTimestampMs(bracket[1]);
    rest = rest.slice(bracket[0].length);
  } else {
    const leading = rest.match(/^(\d{4}-\d{2}-\d{2}T\S+|\d{2}:\d{2}:\d{2}\.\d+|\d+\.\d+)\s+/);
    if (leading !== null) {
      timestampMs = toTimestampMs(leading[1]);
      rest = rest.slice(leading[0].length);
    }
  }

  let direction: Direction = 'unknown';
  const token = rest.match(/^(TX|RX|IN|OUT|->|<-)\s+([\s\S]+)$/i);
  if (token !== null) {
    direction = toDirection(token[1]);
    rest = token[2] ?? '';
  }

  const bytes = parseHex(rest);
  if (bytes === null) return null;

  return {
    index: lineNo,
    nativeId: `line:${lineNo}`,
    timestampMs,
    direction,
    channel: 'serial',
    bytes,
  };
}

export async function readSerialLog(pathname: string): Promise<SerialLog> {
  const size = await fileSize(pathname);
  if (size > DEFAULT_MAX_INPUT_BYTES) {
    throw new IotReaError('input_limit', `log is ${size} bytes, limit is ${DEFAULT_MAX_INPUT_BYTES}`, {
      size,
      limitBytes: DEFAULT_MAX_INPUT_BYTES,
    });
  }
  const digest = await sha256File(pathname);
  let text: string;
  try {
    text = await readFile(pathname, 'utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `cannot read ${pathname}: ${message}`, { path: pathname });
  }

  const frames: Frame[] = [];
  let skippedLines = 0;
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    const frame = parseSerialLine(line, index + 1);
    if (frame === null) {
      skippedLines += 1;
      return;
    }
    frames.push({ ...frame, index: frames.length + 1 });
  });

  return {
    frames,
    rows: frames.map(toRow),
    skippedLines,
    evidence: {
      source: { path: pathname, sha256: digest, size },
      limitations:
        skippedLines === 0
          ? ['direction and timestamps are producer annotations, not verified on the wire']
          : [`${skippedLines} line(s) did not parse and were not interpreted`],
    },
  };
}

function toDirection(value: unknown): Direction {
  if (typeof value !== 'string') return 'unknown';
  switch (value.toLowerCase()) {
    case 'tx':
    case 'out':
    case '->':
      return 'tx';
    case 'rx':
    case 'in':
    case '<-':
      return 'rx';
    default:
      return 'unknown';
  }
}

function toTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Values above 1e11 are already epoch milliseconds; smaller ones are seconds.
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value !== 'string') return null;

  const epoch = Date.parse(value);
  if (Number.isFinite(epoch)) return epoch;

  const clock = value.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{1,3})$/);
  if (clock !== null) {
    const [, hours, minutes, seconds, fraction] = clock;
    return (
      Number(hours) * 3600_000 +
      Number(minutes) * 60_000 +
      Number(seconds) * 1000 +
      Number((fraction ?? '').padEnd(3, '0'))
    );
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1e11 ? numeric : numeric * 1000;
  return null;
}
