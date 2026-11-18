import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildObservations, normalizeHex, rowsToObservations } from '../src/app/buildObservations.js';
import { parseCsvLabels, parseJsonLabels, parseLabels } from '../src/domain/labels.js';
import { tinyPcapUdp } from './helpers.js';

describe('parseCsvLabels', () => {
  it('parses a typed header and rows', () => {
    const map = parseCsvLabels('frame,temperature,mode,on\n3,21.5,heat,true\n4,22.5,cool,false');

    expect(map.get('3')).toEqual({ temperature: 21.5, mode: 'heat', on: true });
    expect(map.get('4')).toEqual({ temperature: 22.5, mode: 'cool', on: false });
  });

  it('accepts frameId and quoted cells', () => {
    const map = parseCsvLabels('frameId,temperature\n"7",20');
    expect(map.get('7')).toEqual({ temperature: 20 });
  });

  it('rejects a header without a frame column', () => {
    expect(() => parseCsvLabels('id,temperature\n1,20')).toThrow(/first column must be frame/);
  });

  it('rejects rows with the wrong cell count', () => {
    expect(() => parseCsvLabels('frame,a,b\n1,2')).toThrow(/has 2 cells/);
  });
});

describe('parseJsonLabels', () => {
  it('accepts a frame map', () => {
    const map = parseJsonLabels('{"3":{"temperature":21.5},"4":{"temperature":"22.5"}}');
    expect(map.get('3')).toEqual({ temperature: 21.5 });
    expect(map.get('4')).toEqual({ temperature: 22.5 });
  });

  it('accepts an observation-style array', () => {
    const map = parseJsonLabels('[{"frameId":"9","vars":{"mode":"heat"}}]');
    expect(map.get('9')).toEqual({ mode: 'heat' });
  });

  it('rejects unsupported value types', () => {
    expect(() => parseJsonLabels('{"3":{"temperature":[1,2]}}')).toThrow(/unsupported value type/);
  });

  it('detects format automatically', () => {
    expect(parseLabels('{"3":{"a":1}}').get('3')).toEqual({ a: 1 });
    expect(parseLabels('frame,a\n3,1').get('3')).toEqual({ a: 1 });
  });
});

describe('normalizeHex', () => {
  it('joins repeated producer values and strips separators', () => {
    expect(normalizeHex(['01', '03', '00'])).toBe('010300');
    expect(normalizeHex('01:03:00')).toBe('010300');
    expect(normalizeHex('0x0A 0x0B')).toBe('0a0b');
  });

  it('returns null for missing or malformed values', () => {
    expect(normalizeHex(undefined)).toBeNull();
    expect(normalizeHex('')).toBeNull();
    expect(normalizeHex('abc')).toBeNull();
    expect(normalizeHex('zz')).toBeNull();
  });
});

describe('rowsToObservations', () => {
  const labels = new Map([
    ['1', { temperature: 21.5 }],
    ['3', { temperature: 23 }],
  ]);

  it('joins payload segments, keeps labels and accounts for skipped frames', () => {
    const assembled = rowsToObservations(
      [
        { frameNumber: 1, fields: { 'data.data': ['01', '03'] } },
        { frameNumber: 2, fields: {} },
        { frameNumber: 3, fields: { 'data.data': 'AA BB' } },
        { frameNumber: 4, fields: { 'data.data': 'cc' } },
      ],
      'data.data',
      labels,
    );

    expect(assembled.observations).toEqual([
      { frameId: '1', vars: { temperature: 21.5 }, hex: '0103' },
      { frameId: '3', vars: { temperature: 23 }, hex: 'aabb' },
      { frameId: '4', vars: {}, hex: 'cc' },
    ]);
    expect(assembled.stats).toEqual({
      frames: 4,
      withPayload: 3,
      skippedNoPayload: 1,
      unlabelled: 1,
      malformedHex: 0,
    });
    expect(assembled.unknowns.join(' ')).toContain('no "data.data" value');
    expect(assembled.unknowns.join(' ')).toContain('carry no labels');
  });

  it('reports an empty match set as scoped, not absent', () => {
    const assembled = rowsToObservations([], 'data.data', new Map());
    expect(assembled.observations).toHaveLength(0);
    expect(assembled.unknowns[0]).toContain('does not prove absence');
  });
});

const hasTshark = (() => {
  const entries = (process.env.PATH ?? '').split(path.delimiter);
  return entries.some((entry) => path.isAbsolute(entry) && existsSync(path.join(entry, 'tshark')));
})();

describe.skipIf(!hasTshark)('buildObservations integration', () => {
  it('turns a capture plus labels into diff-compatible observations', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-obs-'));
    const capture = path.join(dir, 'sample.pcap');
    const labels = path.join(dir, 'labels.csv');
    await writeFile(capture, tinyPcapUdp(Buffer.from([0x01, 0x03, 0x00, 0x0a])));
    await writeFile(labels, 'frame,temperature\n1,21.5\n', 'utf8');

    try {
      const result = await buildObservations({
        path: capture,
        payloadField: 'data.data',
        labelsPath: labels,
        displayFilter: 'udp',
      });

      expect(result.observations.length).toBeGreaterThanOrEqual(1);
      expect(result.observations[0]?.vars).toEqual({ temperature: 21.5 });
      expect(result.observations[0]?.hex).toContain('0103');
      expect(result.evidence.source.sha256).toHaveLength(64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
