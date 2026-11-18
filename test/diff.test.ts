import { describe, expect, it } from 'vitest';
import { checksumCandidates } from '../src/domain/checksum.js';
import { diffObservations } from '../src/domain/diff.js';
import { inferFields } from '../src/domain/inference.js';
import { sensorObservations } from './helpers.js';

const VALUES = [21.5, 22.25, 23.0, 19.75, 24.5];

describe('diffObservations', () => {
  it('marks only the bytes that actually change (float exponent + checksum)', () => {
    const report = diffObservations(sensorObservations(VALUES));
    const variable = report.regions.flatMap((region) =>
      Array.from({ length: region.width }, (_, index) => region.offset + index),
    );

    // All five temperatures share sign/exponent bytes (00 00 .. 41), so only
    // the mantissa byte and the trailing sum8 change. The type hypothesis still
    // recovers the whole four-byte field from the labels.
    expect(variable).toEqual([6, 8]);
    expect(report.unknowns).toEqual([]);
  });

  it('refuses to align unequal lengths and records the reason', () => {
    const frames = sensorObservations(VALUES);
    frames.push({ frameId: 'short', vars: { temperature: 30 }, bytes: Buffer.from([0x01, 0x02]) });
    const report = diffObservations(frames);

    expect(report.unknowns[0]).toContain('lengths differ');
    expect(report.excludedFrameIds).toEqual(['short']);
  });
});

describe('inferFields', () => {
    it('recovers f32 little-endian at offset 4 with full confidence', () => {
    const report = inferFields(sensorObservations(VALUES));
    const field = report.fields.find((candidate) => candidate.variable === 'temperature');

    expect(field).toBeDefined();
    expect(field?.type).toBe('f32');
    expect(field?.endian).toBe('le');
    expect(field?.offset).toBe(4);
    expect(field?.confidence).toBe(1);
  });

  it('prefers unsigned over signed when both types fit the same bytes', () => {
    const observations = [10, 20, 300].map((value, index) => {
      const bytes = Buffer.alloc(2);
      bytes.writeUInt16BE(value, 0);
      return { frameId: `u${index + 1}`, vars: { register: value }, bytes };
    });

    const field = inferFields(observations).fields.find((candidate) => candidate.variable === 'register');

    // Without a tie-break, i16 wins merely by appearing later in the scan.
    expect(field).toMatchObject({ type: 'u16', endian: 'be', confidence: 1 });
  });

  it('keeps label matching, but the differential reports stable bytes', () => {
    const observations = sensorObservations([20, 20, 20]);
    const report = inferFields(observations);
    const differential = diffObservations(observations);

    // Constant frames still confirm the labelled value; no type is invented
    // beyond what the labels support.
    expect(report.fields[0]?.variable).toBe('temperature');
    expect(differential.regions).toHaveLength(0);
    expect(differential.unknowns[0]).toContain('no byte varied');
  });
});

describe('checksumCandidates', () => {
  it('finds the trailing sum8 over the frame prefix', () => {
    const report = checksumCandidates(sensorObservations(VALUES));
    const candidate = report.candidates[0];

    expect(candidate?.algorithm).toBe('sum8');
    expect(candidate?.position).toBe(8);
    expect(candidate?.confidence).toBe(1);
  });

  it('says nothing when no algorithm reproduces the frames', () => {
    const report = checksumCandidates(
      sensorObservations(VALUES).map((observation) => ({ ...observation, bytes: observation.bytes.subarray(0, 4) })),
    );

    expect(report.candidates).toHaveLength(0);
    expect(report.unknowns.length).toBeGreaterThan(0);
  });
});
