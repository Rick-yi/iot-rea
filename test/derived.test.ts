import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffFrames } from '../src/app/diffFrames.js';
import { renderKaitai } from '../src/app/exportKsy.js';
import { diffObservations, type Observation } from '../src/domain/diff.js';
import { detectDerivedFields } from '../src/domain/derived.js';
import { inferFields } from '../src/domain/inference.js';
import { sensorObservations } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function totalLengthFrames(payloadLengths: number[]): Observation[] {
  return payloadLengths.map((length, index) => {
    const bytes = Buffer.alloc(2 + length);
    bytes.writeUInt8(0xaa, 0);
    bytes.writeUInt8(bytes.length, 1); // total frame length
    for (let offset = 2; offset < bytes.length; offset += 1) bytes.writeUInt8(0x11, offset);
    return { frameId: `f${index + 1}`, vars: { payload: length }, bytes };
  });
}

function payloadLengthFrames(payloadLengths: number[]): Observation[] {
  return payloadLengths.map((length, index) => {
    const bytes = Buffer.alloc(2 + length);
    bytes.writeUInt8(0xaa, 0);
    bytes.writeUInt8(length, 1); // remaining length
    for (let offset = 2; offset < bytes.length; offset += 1) bytes.writeUInt8(0x22, offset);
    return { frameId: `f${index + 1}`, vars: { payload: length }, bytes };
  });
}

describe('derived fields', () => {
  it('detects a total-length field only when frame lengths differ', () => {
    const frames = totalLengthFrames([1, 2, 3, 5]);
    const derived = detectDerivedFields(frames);

    expect(derived[0]).toMatchObject({ offset: 1, width: 1, type: 'u8', relation: 'frame-length', confidence: 1 });
    expect(derived[0]?.matched).toBe(4);
  });

  it('detects a remaining-length field', () => {
    const derived = detectDerivedFields(payloadLengthFrames([1, 2, 3, 5]));
    expect(derived[0]).toMatchObject({ offset: 1, relation: 'remaining-length' });
  });

  it('refuses to call a constant length a derived field', () => {
    const frames = totalLengthFrames([2, 2, 2, 2]);
    expect(detectDerivedFields(frames)).toEqual([]);
  });

  it('skips masked checksum positions', () => {
    const frames = totalLengthFrames([1, 2, 3, 5]);
    expect(detectDerivedFields(frames, { excludeOffsets: new Set([1]) })).toEqual([]);
  });
});

describe('checksum-aware masking', () => {
  const frames = sensorObservations([21.5, 22.25, 23.0, 19.75, 24.5]);

  it('keeps checksum bytes out of variable regions and field inference', () => {
    const masked = new Set([8]);
    const report = diffObservations(frames, { excludeOffsets: masked });
    const variable = report.regions.flatMap((region) =>
      Array.from({ length: region.width }, (_, index) => region.offset + index),
    );

    expect(variable).toEqual([6]);
    expect(report.maskedOffsets).toEqual([8]);

    const inference = inferFields(frames, undefined, { excludeOffsets: masked });
    const field = inference.fields.find((candidate) => candidate.variable === 'temperature');
    expect(field).toMatchObject({ offset: 4, type: 'f32', endian: 'le' });
    expect(inference.fields.some((candidate) => candidate.offset === 8)).toBe(false);
  });

  it('reports the mask in diffFrames and keeps the checksum in the draft', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-derived-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'obs.json');
    const payload = frames.map((obs) => ({
      frameId: obs.frameId,
      vars: obs.vars,
      hex: obs.bytes.toString('hex'),
    }));
    await writeFile(file, JSON.stringify(payload), 'utf8');

    const draft = await diffFrames({ path: file });

    expect(draft.differential.maskedOffsets).toEqual([8]);
    expect(draft.unknowns.join(' ')).toContain('masked as derived');
    expect(draft.derived).toEqual([]); // equal frame lengths
    expect(draft.checksums[0]?.algorithm).toBe('sum8');
  });
});

describe('length-field alignment', () => {
  function payloadFrames(values: number[], lengths: number[], encodeLength: (total: number, payload: number) => number) {
    return values.map((value, index) => {
      const length = lengths[index] ?? 1;
      const bytes = Buffer.alloc(2 + length);
      bytes.writeUInt8(0xaa, 0);
      bytes.writeUInt8(encodeLength(bytes.length, length), 1);
      bytes.writeUInt8(value, 2);
      for (let offset = 3; offset < bytes.length; offset += 1) bytes.writeUInt8(0x11, offset);
      return { frameId: `p${index + 1}`, vars: { value }, bytes };
    });
  }

  async function draftFor(frames: Observation[]) {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-align-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'obs.json');
    await writeFile(
      file,
      JSON.stringify(frames.map((obs) => ({ frameId: obs.frameId, vars: obs.vars, hex: obs.bytes.toString('hex') }))),
      'utf8',
    );
    return diffFrames({ path: file });
  }

  it('uses a total-length field to compare the common payload window', async () => {
    const frames = payloadFrames([0x10, 0x20, 0x30, 0x40], [1, 2, 3, 5], (total) => total);
    const draft = await draftFor(frames);

    expect(draft.derived[0]).toMatchObject({ offset: 1, relation: 'frame-length' });
    expect(draft.differential.alignment).toEqual({
      kind: 'length-field',
      fieldOffset: 1,
      fieldWidth: 1,
      payloadStart: 2,
      payloadLength: 1,
    });
    expect(draft.differential.alignedLength).toBe(3);
    expect(draft.differential.unknowns.join(' ')).toContain('length field at 0x1');

    const field = draft.fields.find((candidate) => candidate.variable === 'value');
    expect(field).toMatchObject({ offset: 2, type: 'u8', confidence: 1 });
  });

  it('uses a remaining-length field as well', async () => {
    const frames = payloadFrames([0x10, 0x20, 0x30, 0x40], [1, 2, 3, 5], (_total, payload) => payload);
    const draft = await draftFor(frames);

    expect(draft.derived[0]?.relation).toBe('remaining-length');
    expect(draft.differential.alignment).toMatchObject({ payloadStart: 2, payloadLength: 1 });
    expect(draft.fields.find((candidate) => candidate.variable === 'value')?.offset).toBe(2);
  });
});

describe('Kaitai export', () => {
  it('places a detected length field in the sequence with its relation', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-derived-ksy-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'obs.json');
    const frames = totalLengthFrames([1, 2, 3, 5]);
    await writeFile(
      file,
      JSON.stringify(frames.map((obs) => ({ frameId: obs.frameId, vars: obs.vars, hex: obs.bytes.toString('hex') }))),
      'utf8',
    );

    const draft = await diffFrames({ path: file });
    const rendered = renderKaitai(draft, { id: 'length_frames' });

    expect(rendered.text).toContain('- id: length_frame_length_1\n    type: u1');
    expect(rendered.text).toContain('derived frame-length');
  });
});
