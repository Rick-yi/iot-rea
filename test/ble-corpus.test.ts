/**
 * BLE provider against Wireshark's ATT dissector corpus.
 *
 * This is NOT a device capture: it is the coverage corpus maintained in
 * wireshark/wireshark (test/captures/btatt_coverage.pcap) and is fetched by CI.
 * It exercises a wide range of ATT opcodes and handles through the real
 * TShark path without committing a third-party binary to this repository.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bleFrames } from '../src/app/bleFrames.js';

const corpus = process.env.IOT_REA_BLE_CORPUS;
const hasCorpus = corpus !== undefined && corpus !== '' && existsSync(corpus);

describe.skipIf(!hasCorpus)('Wireshark ATT corpus', () => {
  it('normalizes ATT frames and keeps evidence', async () => {
    const result = await bleFrames({ path: corpus as string });

    expect(result.frames.length).toBeGreaterThan(0);
    expect(result.stats.rows).toBeGreaterThanOrEqual(result.frames.length);
    expect(result.frames.every((frame) => frame.channel.startsWith('att:'))).toBe(true);
    expect(result.frames.some((frame) => frame.channel !== 'att:control')).toBe(true);
    expect(result.evidence.source.sha256).toHaveLength(64);
    expect(result.evidence.tool?.versionBanner).toContain('TShark');
  });
});
