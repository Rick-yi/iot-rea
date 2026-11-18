/**
 * BLE provider integration over a synthetic btsnoop capture.
 *
 * The fixture is generated in code, not recorded from a device: it proves the
 * HCI -> L2CAP -> ATT path through TShark and the channel/direction mapping.
 * A real-device capture is still required before claiming field parity.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bleFrames } from '../src/app/bleFrames.js';
import { buildBtsnoop, sampleBleCapture } from './fixtures/bleBtsnoop.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const hasTshark = (() => {
  const entries = (process.env.PATH ?? '').split(path.delimiter);
  return entries.some((entry) => path.isAbsolute(entry) && existsSync(path.join(entry, 'tshark')));
})();

describe('btsnoop fixture shape', () => {
  it('is an H4 btsnoop file with five records', () => {
    const capture = sampleBleCapture();

    expect(capture.toString('ascii', 0, 8)).toBe('btsnoop\0');
    expect(capture.readUInt32BE(8)).toBe(1);
    expect(capture.readUInt32BE(12)).toBe(1002);

    // Walk the records: header (16 bytes) + record header (24 bytes) + data.
    let offset = 16;
    let count = 0;
    while (offset + 24 <= capture.length) {
      const included = capture.readUInt32BE(offset + 4);
      offset += 24 + included;
      count += 1;
    }
    expect(count).toBe(5);
    expect(offset).toBe(capture.length);
  });

  it('keeps the controller-to-host flag on notifications only', () => {
    const capture = buildBtsnoop([
      { controllerToHost: true, l2cap: Buffer.from([0x01, 0x00, 0x04, 0x00, 0x1b, 0x12]) },
      { controllerToHost: false, l2cap: Buffer.from([0x01, 0x00, 0x04, 0x00, 0x12, 0x15]) },
    ]);

    const firstFlags = capture.readUInt32BE(16 + 8);
    const secondFlags = capture.readUInt32BE(16 + 24 + capture.readUInt32BE(16 + 4) + 8);
    expect(firstFlags & 0x01).toBe(1);
    expect(secondFlags & 0x01).toBe(0);
  });
});

describe.skipIf(!hasTshark)('BLE provider over btsnoop', () => {
  it('maps notifications and writes to ATT channels with directions', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-ble-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const capture = path.join(dir, 'sample.btsnoop');
    const labels = path.join(dir, 'labels.csv');
    await writeFile(capture, sampleBleCapture());
    await writeFile(labels, 'frame,value\n1,0x102\n2,0x103\n5,0x104\n', 'utf8');

    const result = await bleFrames({ path: capture, labelsPath: labels });

    expect(result.frames).toHaveLength(5);
    expect(result.stats).toMatchObject({
      attFrames: 5,
      controlFrames: 0,
      skippedNoValue: 0,
      unknownDirection: 0,
    });

    const notifications = result.frames.filter((frame) => frame.channel === 'att:0x0012');
    const writes = result.frames.filter((frame) => frame.channel === 'att:0x0015');
    expect(notifications).toHaveLength(3);
    expect(writes).toHaveLength(2);
    expect(notifications.every((frame) => frame.direction === 'rx')).toBe(true);
    expect(writes.every((frame) => frame.direction === 'tx')).toBe(true);
    expect(result.frames[0]?.hex).toBe('01 02');

    expect(result.observations).toHaveLength(5);
    expect(result.observations?.[0]).toMatchObject({
      frameId: '1',
      vars: { value: 0x102 },
      hex: '0102',
    });
    expect(result.evidence.source.sha256).toHaveLength(64);
    expect(result.evidence.tool?.versionBanner).toContain('TShark');
  });
});
