import { describe, expect, it } from 'vitest';
import { attChannel, attOpcodeInfo, bleDirection, normalizeAttHandle, parseAttOpcode } from '../src/domain/ble.js';
import { rowsToBleFrames } from '../src/providers/ble.js';
import type { TsharkRow } from '../src/providers/tshark.js';

describe('ATT identifiers', () => {
  it('parses opcodes in hex and decimal', () => {
    expect(parseAttOpcode('0x12')).toBe(0x12);
    expect(parseAttOpcode('18')).toBe(18);
    expect(parseAttOpcode(['0x1b'])).toBe(0x1b);
    expect(parseAttOpcode('')).toBeNull();
    expect(parseAttOpcode('zz')).toBeNull();
  });

  it('names known opcodes and leaves unknown ones unnamed', () => {
    expect(attOpcodeInfo(0x1b)?.name).toBe('handle-value-notification');
    expect(attOpcodeInfo(0x12)?.direction).toBe('tx');
    expect(attOpcodeInfo(0x99)).toBeNull();
  });

  it('normalizes handles to 0xhhhh and gives control frames a channel', () => {
    expect(normalizeAttHandle('0x12')).toBe('0x0012');
    expect(normalizeAttHandle('18')).toBe('0x0012');
    expect(normalizeAttHandle('0x0012')).toBe('0x0012');
    expect(normalizeAttHandle('65536')).toBeNull();
    expect(normalizeAttHandle('-1')).toBeNull();
    expect(attChannel(undefined)).toBe('att:control');
    expect(attChannel('0x2a')).toBe('att:0x002a');
  });
});

describe('bleDirection', () => {
  it('falls back to ATT opcode semantics', () => {
    expect(bleDirection({ opcode: '0x12' })).toBe('tx');
    expect(bleDirection({ opcode: '0x1b' })).toBe('rx');
    expect(bleDirection({ opcode: '0x05' })).toBe('rx');
    expect(bleDirection({ opcode: '0x99' })).toBe('unknown');
    expect(bleDirection({})).toBe('unknown');
  });

  it('uses addresses against an explicit peer', () => {
    const peerAddress = 'aa:bb:cc:dd:ee:ff';
    const other = '11:22:33:44:55:66';
    expect(bleDirection({ opcode: '0x12', srcAddress: peerAddress, dstAddress: other, peerAddress })).toBe('rx');
    expect(bleDirection({ opcode: '0x1b', srcAddress: other, dstAddress: peerAddress, peerAddress })).toBe('tx');
    // Address forms with dashes are normalized before comparison.
    expect(bleDirection({ opcode: '0x12', srcAddress: 'AA-BB-CC-DD-EE-FF', dstAddress: other, peerAddress })).toBe('rx');
  });

  it('does not let addresses override an unrelated third-party pair', () => {
    expect(
      bleDirection({
        opcode: '0x1b',
        srcAddress: '11:22:33:44:55:66',
        dstAddress: 'aa:bb:cc:dd:ee:ff',
        peerAddress: 'aa:bb:cc:dd:ee:ff',
      }),
    ).toBe('tx');
  });
});

describe('rowsToBleFrames', () => {
  const rows: TsharkRow[] = [
    {
      frameNumber: 1,
      fields: {
        'btatt.handle': '0x12',
        'btatt.opcode': '0x1b',
        'btatt.value': ['01', '02'],
        'frame.time_epoch': '1700000000.5',
        'bthci_acl.src.bd_addr': 'AA-BB-CC-DD-EE-FF',
        'bthci_acl.dst.bd_addr': '11:22:33:44:55:66',
      },
    },
    {
      frameNumber: 2,
      fields: {
        'btatt.opcode': '0x03',
        'btatt.value': '1b 02',
        'frame.time_epoch': '1700000001',
      },
    },
    {
      frameNumber: 3,
      fields: { 'btatt.handle': '0x12' },
    },
  ];

  it('maps handles to channels, joins values and derives direction', () => {
    const assembled = rowsToBleFrames(rows, 'aa:bb:cc:dd:ee:ff');

    expect(assembled.frames).toHaveLength(2);
    expect(assembled.frames[0]).toMatchObject({
      nativeId: '1',
      channel: 'att:0x0012',
      direction: 'rx',
      timestampMs: 1700000000500,
    });
    expect(assembled.frames[0]?.bytes.toString('hex')).toBe('0102');
    expect(assembled.frames[1]).toMatchObject({ nativeId: '2', channel: 'att:control', direction: 'rx' });
    expect(assembled.frames[1]?.bytes.toString('hex')).toBe('1b02');
  });

  it('accounts for skipped and control frames instead of dropping them silently', () => {
    const assembled = rowsToBleFrames(rows);

    expect(assembled.stats).toEqual({
      rows: 3,
      attFrames: 2,
      controlFrames: 1,
      skippedNoValue: 1,
      unknownDirection: 0,
    });
    expect(assembled.unknowns.join(' ')).toContain('no btatt.value');
    expect(assembled.unknowns.join(' ')).toContain('att:control');
  });

  it('counts unknown directions and says what to supply', () => {
    const assembled = rowsToBleFrames([
      { frameNumber: 9, fields: { 'btatt.handle': '0x2a', 'btatt.opcode': '0x99', 'btatt.value': '00' } },
    ]);

    expect(assembled.stats.unknownDirection).toBe(1);
    expect(assembled.unknowns.join(' ')).toContain('unknown direction');
  });
});
