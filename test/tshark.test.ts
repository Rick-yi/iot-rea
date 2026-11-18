import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTsharkArgs, parseTsharkJson, validateSelectors } from '../src/providers/tshark.js';
import { inspectCapture } from '../src/app/inspectCapture.js';
import { tinyPcapUdp } from './helpers.js';

describe('buildTsharkArgs', () => {
  it('maps every option and always reads the private copy', () => {
    const args = buildTsharkArgs(
      {
        path: 'ignored.pcap',
        fields: ['frame.number', 'udp.dstport'],
        displayFilter: 'udp',
        decodeAs: ['udp.port==5555,mqtt'],
        packetLimit: 100,
        twoPass: true,
      },
      '/private/copy.pcap',
    );

    expect(args).toEqual([
      '-r', '/private/copy.pcap', '-n', '-T', 'json',
      '-e', 'frame.number', '-e', 'udp.dstport',
      '-Y', 'udp',
      '-d', 'udp.port==5555,mqtt',
      '-c', '100',
      '-2',
    ]);
  });

  it('refuses selector budgets that would overflow argv', () => {
    expect(() => validateSelectors(new Array(1025).fill('a'), [])).toThrow(/at most 1024 fields/);
    expect(() => validateSelectors([`${'a'.repeat(9000)}`], [])).toThrow(/length limit/);
  });
});

describe('parseTsharkJson', () => {
  it('keeps repeated values as arrays and never fabricates missing fields', () => {
    const json = JSON.stringify([
      {
        _source: { layers: { 'frame.number': ['1'], 'ip.src': ['10.0.0.1'], 'data.data': ['01', '02'] } },
      },
    ]);

    const rows = parseTsharkJson(json, ['frame.number', 'ip.src', 'data.data', 'missing.field']);

    expect(rows[0]).toEqual({
      'frame.number': ['1'],
      'ip.src': ['10.0.0.1'],
      'data.data': ['01', '02'],
    });
  });

  it('returns an empty list for empty producer output', () => {
    expect(parseTsharkJson('', ['frame.number'])).toEqual([]);
  });

  it('fails instead of returning partial data on invalid JSON', () => {
    expect(() => parseTsharkJson('{', ['frame.number'])).toThrow(/could not be parsed/);
  });
});

const hasTshark = (() => {
  const entries = (process.env.PATH ?? '').split(path.delimiter);
  return entries.some((entry) => path.isAbsolute(entry) && existsSync(path.join(entry, 'tshark')));
})();

describe.skipIf(!hasTshark)('inspect-capture integration', () => {
  it('reads one UDP payload and reports its window', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-test-'));
    const capture = path.join(dir, 'sample.pcap');
    await writeFile(capture, tinyPcapUdp(Buffer.from([0x01, 0x03, 0x00, 0x00, 0x0a])));

    try {
      const result = await inspectCapture({
        path: capture,
        fields: ['frame.number', 'udp.dstport', 'data.data'],
        displayFilter: 'udp',
      });

      expect(result.window.total).toBeGreaterThanOrEqual(1);
      expect(result.evidence.source.sha256).toHaveLength(64);
      expect(result.evidence.tool?.versionBanner).toBeTruthy();
      expect(result.rows[0]?.frameNumber).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
