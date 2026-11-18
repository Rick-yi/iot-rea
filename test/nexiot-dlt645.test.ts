/**
 * DL/T 645 encoding test against NexIoT's HexFunctions helpers.
 *
 * The transforms (+0x33, reversed BCD address, reversed DI, byte-sum CS) are
 * taken from the upstream helpers; the 68/16 envelope is documented in the
 * fixture and not attributed to that file.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffFrames } from '../src/app/diffFrames.js';
import { renderKaitai } from '../src/app/exportKsy.js';
import { verifyHypotheses } from '../src/app/verifyHypotheses.js';
import { checksumCandidates } from '../src/domain/checksum.js';
import { diffObservations, type Observation } from '../src/domain/diff.js';
import { inferFields } from '../src/domain/inference.js';
import {
  add0x33,
  bcd4,
  build645EnergyResponse,
  csSum,
  encode645Address,
  sub0x33,
} from './fixtures/nexiotDlt645.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const ENERGIES = [1234, 2000, 3456, 7890, 9999];
const ADDRESS = '000000000001';
const DI = '00010000';

function variableOffsets(observations: Observation[]): number[] {
  const report = diffObservations(observations);
  return report.regions.flatMap((region) =>
    Array.from({ length: region.width }, (_, index) => region.offset + index),
  );
}

function observationsFor(values: number[]): Observation[] {
  return values.map((energy, index) => ({
    frameId: `e${index + 1}`,
    vars: { energy },
    bytes: build645EnergyResponse(ADDRESS, DI, energy),
  }));
}

describe('upstream transform sanity', () => {
  it('round-trips the 0x33 offset and encodes BCD as documented', () => {
    const raw = Buffer.from([0x00, 0x01, 0x02]);
    expect(add0x33(raw).toString('hex')).toBe('333435');
    expect(sub0x33(add0x33(raw)).equals(raw)).toBe(true);
    expect(bcd4(1234).toString('hex')).toBe('00001234');
    expect(add0x33(bcd4(1234)).toString('hex')).toBe('33334567');
  });

  it('encodes the 12-digit address as reversed BCD', () => {
    expect(encode645Address(ADDRESS).toString('hex')).toBe('100000000000');
  });

  it('builds a frame whose checksum matches cs_check', () => {
    const frame = build645EnergyResponse(ADDRESS, DI, 1234);
    const body = frame.subarray(0, frame.length - 2);
    expect(frame[frame.length - 1]).toBe(0x16);
    expect(frame[frame.length - 2]).toBe(csSum(body, 256));
  });
});

describe('encoded energy field', () => {
  const observations = observationsFor(ENERGIES);

  it('localizes the encoded value and the checksum', () => {
    // All five values are below 10000, so the two high BCD bytes stay 00 00;
    // only the last two value bytes and the CS are variable.
    expect(variableOffsets(observations)).toEqual([16, 17, 18]);
  });

  it('refuses to invent a type for the +0x33 payload', () => {
    const report = inferFields(observations);

    expect(report.fields).toHaveLength(0);
    expect(report.unknowns.join(' ')).toContain('no field hypothesis');
  });

  it('still identifies the byte-sum CS at the second-to-last byte', () => {
    const candidate = checksumCandidates(observations).candidates[0];

    expect(candidate).toMatchObject({
      algorithm: 'sum8',
      position: 18,
      width: 1,
      endian: 'be',
      coveredFrom: 0,
      coveredTo: 17,
      confidence: 1,
    });
  });
});

describe('hypothesis verdicts over DL/T 645 frames', () => {
  async function writeObservations(observations: Observation[]): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-645-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'obs.json');
    const payload = observations.map((obs) => ({
      frameId: obs.frameId,
      vars: obs.vars,
      hex: obs.bytes.toString('hex'),
    }));
    await writeFile(file, JSON.stringify(payload), 'utf8');
    return file;
  }

  it('verifies the CS claim but rejects identity decoding of an encoded field', async () => {
    const file = await writeObservations(observationsFor(ENERGIES));
    const result = await verifyHypotheses({
      path: file,
      hypotheses: [
        {
          id: 'cs',
          kind: 'checksum',
          claim: 'CS is sum8 over bytes 0..17',
          evidenceRefs: [],
          checks: [
            {
              verifier: 'checksum_coverage',
              args: { algorithm: 'sum8', position: 18, width: 1, endian: 'be', coveredFrom: 0, coveredTo: 17 },
            },
          ],
        },
        {
          id: 'identity',
          kind: 'field_semantics',
          claim: 'energy is a plain u32be at offset 14',
          evidenceRefs: [],
          checks: [
            { verifier: 'type_fit', args: { offset: 14, width: 4, type: 'u32', endian: 'be', variable: 'energy' } },
          ],
        },
        {
          id: 'bcd-transform',
          kind: 'scaling',
          claim: 'energy is packed BCD whose bytes were shifted by +0x33',
          evidenceRefs: [],
          checks: [
            {
              verifier: 'bcd_fit',
              args: { offset: 14, width: 4, variable: 'energy', byteOffset: 0x33 },
            },
          ],
        },
      ],
    });

    // The encoded field is not identity-decodable, but the documented +0x33
    // transform is now a first-class verifier, so the correct hypothesis passes.
    expect(result.verdicts.map((verdict) => verdict.status)).toEqual(['verified', 'rejected', 'verified']);
    expect(result.verdicts[2]?.checks[0]).toMatchObject({ matched: 5, total: 5 });
  });

  it('drafts a Kaitai layout that keeps the encoded field as a gap', async () => {
    const file = await writeObservations(observationsFor(ENERGIES));
    const draft = await diffFrames({ path: file });
    const rendered = renderKaitai(draft, { id: 'nexiot_dlt645_energy' });

    expect(rendered.text).toContain('- id: checksum_sum8\n    type: u1');
    expect(rendered.text).not.toContain('id: energy');
    expect(rendered.text).toContain('no field hypothesis');
  });
});
