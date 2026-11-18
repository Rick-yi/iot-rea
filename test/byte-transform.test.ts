import { describe, expect, it } from 'vitest';
import type { Hypothesis } from '../src/contracts/hypotheses.js';
import { verifyHypothesis } from '../src/domain/verify.js';
import type { Observation } from '../src/domain/diff.js';

function obs(values: number[], encode: (value: number) => Buffer): Observation[] {
  return values.map((value, index) => ({
    frameId: `t${index + 1}`,
    vars: { value },
    bytes: Buffer.concat([Buffer.from([0xaa, 0x55]), encode(value), Buffer.from([0x00])]),
  }));
}

function claim(args: Record<string, unknown>): Hypothesis {
  return {
    id: 'h1',
    kind: 'scaling',
    claim: 'the field is a transformed encoding of the label',
    evidenceRefs: [],
    checks: [{ verifier: 'byte_transform', args }],
  };
}

function reverseBits(byte: number): number {
  let value = 0;
  for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | ((byte >> bit) & 1);
  return value & 0xff;
}

describe('byte_transform', () => {
  it('verifies a byte-wise XOR', () => {
    const observations = obs([0x1234, 0x2345, 0x3456], (value) => {
      const bytes = Buffer.alloc(2);
      bytes.writeUInt16BE(value, 0);
      return Buffer.from(bytes.map((byte) => byte ^ 0xaa));
    });

    const verdict = verifyHypothesis(
      claim({
        offset: 2, width: 2, variable: 'value', type: 'u16', endian: 'be',
        transform: { kind: 'xor', operand: 0xaa },
      }),
      observations,
    );

    expect(verdict.status).toBe('verified');
    expect(verdict.checks[0]).toMatchObject({ matched: 3, total: 3, counterexamples: [] });
  });

  it('rejects a wrong XOR operand with counterexamples', () => {
    const observations = obs([0x12, 0x34, 0x56], (value) => Buffer.from([value ^ 0xaa]));

    const verdict = verifyHypothesis(
      claim({ offset: 2, width: 1, variable: 'value', type: 'u8', transform: { kind: 'xor', operand: 0x55 } }),
      observations,
    );

    expect(verdict.status).toBe('rejected');
    expect(verdict.checks[0]?.counterexamples).toEqual(['t1', 't2', 't3']);
  });

  it('verifies complement, bit-reverse, nibble-swap and add', () => {
    const complement = obs([0x12, 0x34, 0x56], (value) => Buffer.from([(~value) & 0xff]));
    expect(
      verifyHypothesis(claim({ offset: 2, width: 1, variable: 'value', type: 'u8', transform: { kind: 'not' } }), complement).status,
    ).toBe('verified');

    const reversed = obs([0x01, 0x02, 0x04, 0x08], (value) => Buffer.from([reverseBits(value)]));
    expect(
      verifyHypothesis(
        claim({ offset: 2, width: 1, variable: 'value', type: 'u8', transform: { kind: 'bit-reverse' } }),
        reversed,
      ).status,
    ).toBe('verified');

    const swapped = obs([0x12, 0x34, 0x56], (value) => Buffer.from([((value & 0x0f) << 4) | (value >> 4)]));
    expect(
      verifyHypothesis(
        claim({ offset: 2, width: 1, variable: 'value', type: 'u8', transform: { kind: 'nibble-swap' } }),
        swapped,
      ).status,
    ).toBe('verified');

    const shifted = obs([1, 2, 3], (value) => Buffer.from([(value + 0x10) & 0xff]));
    expect(
      verifyHypothesis(
        claim({ offset: 2, width: 1, variable: 'value', type: 'u8', transform: { kind: 'add', operand: 0x10 } }),
        shifted,
      ).status,
    ).toBe('verified');
  });

  it('applies transform chains in the declared order', () => {
    // Wire bytes: ((value XOR 0xAA) + 0x10). Decoding therefore removes
    // 0x10 first, then XORs 0xAA.
    const observations = obs([0x12, 0x34, 0x56], (value) => {
      const mixed = (value ^ 0xaa) + 0x10;
      return Buffer.from([mixed & 0xff]);
    });

    const ordered = verifyHypothesis(
      claim({
        offset: 2, width: 1, variable: 'value', type: 'u8',
        transforms: [
          { kind: 'add', operand: 0x10 },
          { kind: 'xor', operand: 0xaa },
        ],
      }),
      observations,
    );
    expect(ordered.status).toBe('verified');

    const reversed = verifyHypothesis(
      claim({
        offset: 2, width: 1, variable: 'value', type: 'u8',
        transforms: [
          { kind: 'xor', operand: 0xaa },
          { kind: 'add', operand: 0x10 },
        ],
      }),
      observations,
    );
    expect(reversed.status).toBe('rejected');
  });

  it('rejects an empty chain as unsupported rather than a pass', () => {
    const observations = obs([1, 2, 3], (value) => Buffer.from([value]));

    const verdict = verifyHypothesis(
      claim({ offset: 2, width: 1, variable: 'value', type: 'u8', transforms: [] }),
      observations,
    );

    expect(verdict.status).toBe('unverified');
    expect(verdict.checks[0]?.detail).toContain('transform');
  });

  it('marks impossible argument combinations as unsupported', () => {
    const observations = obs([1, 2, 3], (value) => Buffer.from([value]));

    const widthMismatch = verifyHypothesis(
      claim({ offset: 2, width: 1, variable: 'value', type: 'u16', transform: { kind: 'not' } }),
      observations,
    );
    expect(widthMismatch.status).toBe('unverified');
    expect(widthMismatch.checks[0]?.detail).toContain('needs width 2');

    const missingOperand = verifyHypothesis(
      claim({ offset: 2, width: 1, variable: 'value', type: 'u8', transform: { kind: 'xor' } }),
      observations,
    );
    expect(missingOperand.status).toBe('unverified');
    expect(missingOperand.checks[0]?.detail).toContain('requires an operand');

    const unknownVariable = verifyHypothesis(
      claim({ offset: 2, width: 1, variable: 'nope', type: 'u8', transform: { kind: 'not' } }),
      observations,
    );
    expect(unknownVariable.status).toBe('unverified');
  });
});
