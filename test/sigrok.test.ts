/**
 * Real sigrok-cli integration. Skipped locally when the tool is absent;
 * CI installs it and IOT_REA_REQUIRE_TOOLS makes absence a failure.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSignalRecording } from '../src/providers/sigrok.js';
import { buildUartVcd } from './fixtures/uartVcd.js';

const hasSigrok = (() => {
  const configured = process.env.IOT_REA_SIGROK;
  if (configured !== undefined && configured !== '') return existsSync(configured);
  const entries = (process.env.PATH ?? '').split(path.delimiter);
  const names = process.platform === 'win32'
    ? ['sigrok-cli.exe', 'sigrok-cli.cmd', 'sigrok-cli']
    : ['sigrok-cli'];
  return entries.some((entry) => path.isAbsolute(entry) && names.some((name) => existsSync(path.join(entry, name))));
})();

describe.skipIf(!hasSigrok)('decode-signals with sigrok-cli', () => {
  it('decodes a generated UART recording', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-sigrok-'));
    const recording = path.join(dir, 'uart.vcd');
    const bytes = [0x55, 0xaa, 0x31];
    await writeFile(recording, buildUartVcd(bytes, { baud: 9600 }), 'utf8');

    try {
      const page = await decodeSignalRecording({
        path: recording,
        decoders: ['uart:rx=RX:baudrate=9600'],
        inputFormat: 'vcd',
        annotations: ['uart=rx-data'],
        lineLimit: null,
      });

      const diagnostic = `stderr: ${page.evidence.stderr ?? ''}`;
      expect(page.lines.length, diagnostic).toBeGreaterThanOrEqual(bytes.length);
      expect(page.window.total, diagnostic).toBeGreaterThanOrEqual(bytes.length);
      expect(page.evidence.source.sha256).toHaveLength(64);
      expect(page.evidence.tool?.versionBanner).toContain('sigrok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
