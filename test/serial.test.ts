import { describe, expect, it } from 'vitest';
import { parseSerialLine } from '../src/providers/serial.js';
import { parseHex, toHex } from '../src/domain/frame.js';

describe('parseSerialLine', () => {
  it('parses an ISO-timestamped TX line', () => {
    const frame = parseSerialLine('[2026-11-18T10:00:00.123Z] TX 01 03 00 00', 4);

    expect(frame?.direction).toBe('tx');
    expect(frame?.nativeId).toBe('line:4');
    expect(frame?.timestampMs).toBe(Date.parse('2026-11-18T10:00:00.123Z'));
    expect(toHex(frame?.bytes ?? Buffer.alloc(0))).toBe('01 03 00 00');
  });

  it('parses RX and arrow forms', () => {
    expect(parseSerialLine('RX 0A 0B', 1)?.direction).toBe('rx');
    expect(parseSerialLine('<- AA BB', 2)?.direction).toBe('rx');
    expect(parseSerialLine('-> CC DD', 3)?.direction).toBe('tx');
  });

  it('keeps bare hex lines but leaves the direction unknown', () => {
    const frame = parseSerialLine('01:03:04:05', 9);
    expect(frame?.direction).toBe('unknown');
    expect(frame?.bytes.toString('hex')).toBe('01030405');
  });

  it('parses JSONL observations', () => {
    const frame = parseSerialLine('{"ts":1690000000.5,"dir":"rx","channel":"uart2","hex":"0103"}', 7);
    expect(frame?.channel).toBe('uart2');
    expect(frame?.direction).toBe('rx');
    expect(frame?.timestampMs).toBe(1690000000500);
  });

  it('rejects comments and malformed lines', () => {
    expect(parseSerialLine('# serial log', 1)).toBeNull();
    expect(parseSerialLine('RX 01 0', 2)).toBeNull();
    expect(parseSerialLine('not hex at all', 3)).toBeNull();
  });
});

describe('parseHex', () => {
  it('accepts separators and prefixes', () => {
    expect(parseHex('0x01 0x02')?.toString('hex')).toBe('0102');
    expect(parseHex('01-02-03')?.toString('hex')).toBe('010203');
    expect(parseHex('0102')?.toString('hex')).toBe('0102');
    expect(parseHex('0 1')).toBeNull();
  });
});
