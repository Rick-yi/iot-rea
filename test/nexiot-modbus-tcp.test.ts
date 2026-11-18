/**
 * Modbus TCP field test against NexIoT's `isModbusTcp` rule.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyHypotheses } from '../src/app/verifyHypotheses.js';
import { checksumCandidates } from '../src/domain/checksum.js';
import { diffObservations, type Observation } from '../src/domain/diff.js';
import { inferFields } from '../src/domain/inference.js';
import { buildReadHoldingTcp } from './fixtures/nexiotModbus.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function variableOffsets(observations: Observation[]): number[] {
  const report = diffObservations(observations);
  return report.regions.flatMap((region) =>
    Array.from({ length: region.width }, (_, index) => region.offset + index),
  );
}

describe('MBAP sanity (mirrors isModbusTcp)', () => {
  it('keeps protocol id 0 and length = totalBytes - 6', () => {
    const frame = buildReadHoldingTcp(0x1234, 1, [10, 20]);
    expect(frame.readUInt16BE(2)).toBe(0);
    expect(frame.readUInt16BE(4)).toBe(frame.length - 6);
  });
});

describe('register field over Modbus TCP', () => {
  const values = [10, 42, 300, 1000, 5];
  const observations: Observation[] = values.map((value, index) => ({
    frameId: `t${index + 1}`,
    vars: { register: value },
    bytes: buildReadHoldingTcp(0x1234, 1, [value]),
  }));

  it('localizes only the register bytes (no CRC in TCP)', () => {
    expect(variableOffsets(observations)).toEqual([9, 10]);
  });

  it('recovers u16 big-endian at offset 9', () => {
    const field = inferFields(observations).fields.find((candidate) => candidate.variable === 'register');
    expect(field).toMatchObject({ offset: 9, width: 2, type: 'u16', endian: 'be', confidence: 1 });
  });

  it('reports no checksum instead of inventing one', () => {
    const report = checksumCandidates(observations);
    expect(report.candidates).toHaveLength(0);
    expect(report.unknowns[0]).toContain('no checksum algorithm');
  });
});

describe('transaction id field over Modbus TCP', () => {
  const values = [0x0102, 0x0203, 0x0304, 0x0405, 0x0506];
  const observations: Observation[] = values.map((value, index) => ({
    frameId: `x${index + 1}`,
    vars: { transaction: value },
    bytes: buildReadHoldingTcp(value, 1, [7]),
  }));

  it('finds the transaction id at offset 0 without touching the length field', () => {
    expect(variableOffsets(observations)).toEqual([0, 1]);

    const field = inferFields(observations).fields.find((candidate) => candidate.variable === 'transaction');
    expect(field).toMatchObject({ offset: 0, width: 2, type: 'u16', endian: 'be', confidence: 1 });
  });
});

describe('hypothesis verdicts over Modbus TCP', () => {
  it('verifies the register claim and rejects a CRC claim that does not exist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-tcp-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'obs.json');
    const observations = [10, 300, 1000].map((value, index) => ({
      frameId: `h${index + 1}`,
      vars: { register: value },
      hex: buildReadHoldingTcp(0x1234, 1, [value]).toString('hex'),
    }));
    await writeFile(file, JSON.stringify(observations), 'utf8');

    const result = await verifyHypotheses({
      path: file,
      hypotheses: [
        {
          id: 'register',
          kind: 'field_semantics',
          claim: 'register is u16be at offset 9',
          evidenceRefs: [],
          checks: [
            { verifier: 'type_fit', args: { offset: 9, width: 2, type: 'u16', endian: 'be', variable: 'register' } },
          ],
        },
        {
          id: 'crc',
          kind: 'checksum',
          claim: 'a trailing sum8 exists at the last byte',
          evidenceRefs: [],
          checks: [
            {
              verifier: 'checksum_coverage',
              args: { algorithm: 'sum8', position: 10, width: 1, endian: 'be', coveredFrom: 0, coveredTo: 9 },
            },
          ],
        },
      ],
    });

    expect(result.verdicts.map((verdict) => verdict.status)).toEqual(['verified', 'rejected']);
  });
});
