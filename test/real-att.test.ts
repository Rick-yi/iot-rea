/**
 * Real-device ATT logs (public issue attachments, fetched by CI).
 *
 * Sources:
 *   - aiobmsble issue #338 (BMS device):  https://github.com/patman15/aiobmsble/issues/338
 *   - baseus-desktop issue #12:          https://github.com/elaxptr/baseus-desktop/issues/12
 *
 * The files are not committed: CI downloads them and sets IOT_REA_ATT_LOGS.
 * Structure tests run without TShark; provider tests need it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bleFrames } from '../src/app/bleFrames.js';
import { readBtsnoopAtt } from './fixtures/btsnoopReader.js';

const logs = (process.env.IOT_REA_ATT_LOGS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '' && existsSync(entry));

const hasTshark = (() => {
  const entries = (process.env.PATH ?? '').split(path.delimiter);
  return entries.some((entry) => path.isAbsolute(entry) && existsSync(path.join(entry, 'tshark')));
})();

describe.skipIf(logs.length === 0)('real ATT logs: structure', () => {
  for (const file of logs) {
    it(`parses ${path.basename(file)}`, () => {
      const summary = readBtsnoopAtt(file);

      expect(summary.datalink).toBe(1002);
      expect(summary.att + summary.acl).toBeGreaterThan(10);
      expect(Object.keys(summary.handles).length).toBeGreaterThan(0);
      expect(Object.keys(summary.opcodes).length).toBeGreaterThan(0);
    });
  }
});

describe.skipIf(logs.length === 0 || !hasTshark)('real ATT logs: BLE provider', () => {
  for (const file of logs) {
    it(`normalizes ${path.basename(file)}`, async () => {
      const result = await bleFrames({ path: file });

      expect(result.frames.length).toBeGreaterThan(0);
      expect(result.stats.attFrames).toBeGreaterThan(0);
      expect(result.frames.some((frame) => frame.channel.startsWith('att:'))).toBe(true);
      const directions = new Set(result.frames.map((frame) => frame.direction));
      expect(directions.has('tx')).toBe(true);
      expect(directions.has('rx')).toBe(true);
      expect(result.evidence.source.sha256).toHaveLength(64);
      expect(result.evidence.tool?.versionBanner).toContain('TShark');
    });
  }
});