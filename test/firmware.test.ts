import { describe, expect, it } from 'vitest';
import { inspectArtifactBytes, sniffFormat } from '../src/domain/artifacts/registry.js';
import { ihexLine, minimalDfuse, uf2Block } from './helpers.js';

const FAMILY_RP2040 = 0xe48bff56;

describe('UF2', () => {
  const blockA = uf2Block({
    targetAddress: 0x10000000,
    payload: Buffer.from('first payload'.padEnd(256, '!')),
    blockNo: 0,
    numBlocks: 2,
    familyId: FAMILY_RP2040,
  });
  const blockB = uf2Block({
    targetAddress: 0x10000100,
    payload: Buffer.from('second payload'.padEnd(256, '?')),
    blockNo: 1,
    numBlocks: 2,
    familyId: FAMILY_RP2040,
  });

  it('recognizes two contiguous blocks as one region', () => {
    const image = inspectArtifactBytes(Buffer.concat([blockA, blockB]));

    expect(image.inventory.format).toBe('uf2');
    expect(image.inventory.regions).toHaveLength(1);

    const region = image.inventory.regions[0];
    expect(region?.path).toBe('family-0xe48bff56/0x10000000-0x100001ff.bin');
    expect(region?.length).toBe(512);
    expect(region?.metadata['familyName']).toBe('RP2040');
    expect(image.regionBytes.get(region?.path ?? '')?.length).toBe(512);
  });

  it('keeps families in separate address spaces', () => {
    const other = uf2Block({
      targetAddress: 0x10000000,
      payload: Buffer.alloc(256, 0x11),
      blockNo: 0,
      numBlocks: 1,
      familyId: 0x1c5f21b0,
    });
    const image = inspectArtifactBytes(Buffer.concat([blockA, other]));

    expect(image.inventory.regions).toHaveLength(2);
    expect(image.inventory.regions.map((region) => region.path).sort()).toEqual([
      'family-0x1c5f21b0/0x10000000-0x100000ff.bin',
      'family-0xe48bff56/0x10000000-0x100000ff.bin',
    ]);
  });

  it('refuses a truncated block', () => {
    expect(sniffFormat(blockA.subarray(0, 500))).toBe('unknown');
  });
});

describe('Intel HEX', () => {
  const body = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a]);
  const text = [
    ihexLine(0x00, 0x0000, body.subarray(0, 3)),
    ihexLine(0x00, 0x0003, body.subarray(3)),
    ihexLine(0x01, 0x0000, Buffer.alloc(0)),
    '',
  ].join('\n');

  it('recognizes and merges contiguous records', () => {
    const image = inspectArtifactBytes(Buffer.from(text, 'ascii'));

    expect(image.inventory.format).toBe('intel-hex');
    expect(image.inventory.regions).toHaveLength(1);
    expect(image.inventory.regions[0]?.path).toBe('0x00000000-0x00000005.bin');
    expect(image.inventory.metadata['dataBytes']).toBe(6);
    expect(image.inventory.metadata['termination']).toBe('eof');
  });

  it('does not scan past an invalid first line', () => {
    const broken = Buffer.from(text.replace(/^:0[0-9A-F]/, ':00'), 'ascii');
    expect(sniffFormat(broken)).toBe('unknown');
  });
});

describe('DfuSe', () => {
  it('verifies the signature and the 16-byte suffix, and stays opaque', () => {
    const image = inspectArtifactBytes(minimalDfuse(Buffer.alloc(32, 0xaa)));

    expect(image.inventory.format).toBe('dfuse');
    expect(image.inventory.regions).toHaveLength(0);
    expect(image.inventory.metadata['suffix']).toMatchObject({ bcdDFU: 0x011a, bLength: 16 });
    expect(image.inventory.unknowns.length).toBeGreaterThan(0);
  });

  it('rejects a file with only the header signature', () => {
    const broken = minimalDfuse(Buffer.alloc(32, 0xaa)).subarray(0, 20);
    expect(sniffFormat(broken)).toBe('unknown');
  });
});
