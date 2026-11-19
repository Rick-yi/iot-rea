import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffFrames } from '../src/app/diffFrames.js';
import { renderKaitai } from '../src/app/exportKsy.js';
import type { Observation } from '../src/domain/diff.js';
import { inferFields } from '../src/domain/inference.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function u12Frames(values: number[], endian: 'be' | 'le'): Observation[] {
  return values.map((value, index) => {
    const bytes = Buffer.alloc(3);
    bytes.writeUInt8(0xaa, 0);
    if (endian === 'be') {
      bytes.writeUInt8(value >> 4, 1);
      bytes.writeUInt8(((value & 0x0f) << 4) | 0x05, 2);
    } else {
      bytes.writeUInt8(value & 0xff, 1);
      bytes.writeUInt8(0x50 | ((value >> 8) & 0x0f), 2);
    }
    return { frameId: `f${index + 1}`, vars: { value }, bytes };
  });
}

describe('12-bit fields', () => {
  it('recovers big-endian and little-endian packing', () => {
    const be = inferFields(u12Frames([0x123, 0x234, 0x345], 'be')).fields[0];
    expect(be).toMatchObject({ offset: 1, width: 2, type: 'u12', endian: 'be', confidence: 1 });

    const le = inferFields(u12Frames([0x123, 0x234, 0x345], 'le')).fields[0];
    expect(le).toMatchObject({ offset: 1, width: 2, type: 'u12', endian: 'le', confidence: 1 });
  });
});

describe('nibble fields', () => {
  it('recovers low and high nibbles when the other nibble is non-zero', () => {
    const low = [3, 7, 9].map((value, index) => ({
      frameId: `l${index + 1}`,
      vars: { value },
      bytes: Buffer.from([0xaa, 0x50 | value]),
    }));
    expect(inferFields(low).fields[0]).toMatchObject({ type: 'u4', bitOffset: 0, offset: 1, confidence: 1 });

    const high = [3, 7, 9].map((value, index) => ({
      frameId: `h${index + 1}`,
      vars: { value },
      bytes: Buffer.from([0xaa, (value << 4) | 0x05]),
    }));
    expect(inferFields(high).fields[0]).toMatchObject({ type: 'u4', bitOffset: 4, offset: 1, confidence: 1 });
  });

  it('prefers u8 when the nibble never differs from the whole byte', () => {
    const frames = [3, 7, 9].map((value, index) => ({
      frameId: `b${index + 1}`,
      vars: { value },
      bytes: Buffer.from([0xaa, value]),
    }));
    expect(inferFields(frames).fields[0]).toMatchObject({ type: 'u8', offset: 1 });
  });
});

describe('bit flags', () => {
  it('recovers a boolean flag inside a byte', () => {
    const frames = [true, false, true].map((flag, index) => ({
      frameId: `b${index + 1}`,
      vars: { enabled: flag },
      bytes: Buffer.from([0xaa, 0x20 | (flag ? 1 : 0)]),
    }));

    const field = inferFields(frames).fields[0];
    expect(field).toMatchObject({ type: 'bit', bitOffset: 0, offset: 1, confidence: 1 });
  });
});

describe('Kaitai export', () => {
  it('keeps bit-level fields out of the byte-based draft and says so', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-bitfields-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'obs.json');
    const frames = u12Frames([0x123, 0x234, 0x345], 'be');
    await writeFile(
      file,
      JSON.stringify(frames.map((obs) => ({ frameId: obs.frameId, vars: obs.vars, hex: obs.bytes.toString('hex') }))),
      'utf8',
    );

    const draft = await diffFrames({ path: file });
    const rendered = renderKaitai(draft, { id: 'bits' });

    expect(rendered.text).not.toContain('type: u12');
    expect(rendered.text).toContain('bit-level fields are not emitted');
  });
});