import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffFrames } from '../src/app/diffFrames.js';
import { renderKaitai } from '../src/app/exportKsy.js';
import type { Observation } from '../src/domain/diff.js';
import { detectCountFields } from '../src/domain/records.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function recordFrames(counts: number[], stride = 3, trailer = 0, lie = false): Observation[] {
  return counts.map((count, index) => {
    const bytes = Buffer.alloc(3 + count * stride + trailer);
    bytes.writeUInt8(0xaa, 0);
    bytes.writeUInt8(0xbb, 1);
    bytes.writeUInt8(lie ? count + 1 : count, 2);
    for (let offset = 3; offset < bytes.length; offset += 1) bytes.writeUInt8(0x11, offset);
    return { frameId: `f${index + 1}`, vars: {}, bytes };
  });
}

async function draftFor(observations: Observation[]) {
  const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-records-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'obs.json');
  await writeFile(
    file,
    JSON.stringify(observations.map((obs) => ({ frameId: obs.frameId, vars: obs.vars, hex: obs.bytes.toString('hex') }))),
    'utf8',
  );
  return diffFrames({ path: file });
}

describe('count fields', () => {
  it('detects a count with a constant record stride', () => {
    const derived = detectCountFields(recordFrames([1, 2, 3, 4]));

    expect(derived[0]).toMatchObject({
      offset: 2,
      width: 1,
      type: 'u8',
      stride: 3,
      trailerBytes: 0,
      confidence: 1,
    });
  });

  it('supports a constant trailer', () => {
    const derived = detectCountFields(recordFrames([1, 2, 3, 4], 3, 2));
    expect(derived[0]).toMatchObject({ stride: 3, trailerBytes: 2 });
  });

  it('refuses a constant count and inconsistent samples', () => {
    expect(detectCountFields(recordFrames([3, 3, 3]))).toEqual([]);
    expect(detectCountFields(recordFrames([1, 2, 3, 4], 3, 0, true))).toEqual([]);
  });

  it('skips masked or excluded ranges', () => {
    expect(detectCountFields(recordFrames([1, 2, 3, 4]), { excludeOffsets: new Set([2]) })).toEqual([]);
    expect(
      detectCountFields(recordFrames([1, 2, 3, 4]), { excludeRanges: [{ offset: 2, width: 1 }] }),
    ).toEqual([]);
  });
});

describe('records in the schema draft', () => {
  it('reports the count field and records in the draft', async () => {
    const draft = await draftFor(recordFrames([1, 2, 3, 4]));

    expect(draft.records).toHaveLength(1);
    expect(draft.records[0]).toMatchObject({ offset: 2, stride: 3 });
    expect(draft.unknowns.join(' ')).toContain('implies 3-byte records');
  });

  it('emits a repeated bytes field in the Kaitai draft', async () => {
    const draft = await draftFor(recordFrames([1, 2, 3, 4]));
    const rendered = renderKaitai(draft, { id: 'records' });

    expect(rendered.text).toContain('- id: record_count_2\n    type: u1');
    expect(rendered.text).toContain('- id: records_2\n    size: 3');
    expect(rendered.text).toContain('repeat-expr: record_count_2');
  });
});