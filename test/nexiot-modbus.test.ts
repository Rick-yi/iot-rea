/**
 * Field testing against a third-party protocol definition.
 *
 * The protocol frames come from NexIoT's ModbusFunctions (see
 * test/fixtures/nexiotModbus.ts for source and commit). Nothing from that
 * repository is executed; only its documented frame layout and CRC algorithm
 * are reproduced independently.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffFrames } from '../src/app/diffFrames.js';
import { renderKaitai } from '../src/app/exportKsy.js';
import { verifyHypotheses } from '../src/app/verifyHypotheses.js';
import { checksumCandidates, computeChecksum } from '../src/domain/checksum.js';
import { diffObservations, type Observation } from '../src/domain/diff.js';
import { inferFields } from '../src/domain/inference.js';
import {
  buildReadHoldingRequest,
  buildReadHoldingResponse,
  buildWriteSingle,
  crc16ModbusRef,
  singleRegisterObservations,
} from './fixtures/nexiotModbus.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const VALUES = [10, 42, 300, 1000, 5];

function variableOffsets(observations: Observation[]): number[] {
  const report = diffObservations(observations);
  return report.regions.flatMap((region) =>
    Array.from({ length: region.width }, (_, index) => region.offset + index),
  );
}

describe('fixture sanity (reference implementation)', () => {
  it('reproduces known Modbus RTU frames', () => {
    expect(buildReadHoldingRequest(1, 0, 10).toString('hex')).toBe('01030000000ac5cd');
    expect(buildWriteSingle(1, 1, 10).toString('hex')).toBe('01060001000a580d');
    expect(crc16ModbusRef(Buffer.from('01030000000a', 'hex'))).toBe(0xcdc5);
    expect(computeChecksum('crc16-modbus', Buffer.from('01030000000a', 'hex'))).toBe(0xcdc5);
  });
});

describe('NexIoT Modbus read-holding response', () => {
  const observations = singleRegisterObservations(VALUES);

  it('localizes exactly the register bytes and the CRC tail', () => {
    expect(variableOffsets(observations)).toEqual([3, 4, 5, 6]);
  });

  it('recovers u16 big-endian at offset 3 with full confidence', () => {
    const report = inferFields(observations);
    const field = report.fields.find((candidate) => candidate.variable === 'register');

    expect(field).toMatchObject({ offset: 3, width: 2, type: 'u16', endian: 'be', confidence: 1 });
    expect(report.unknowns).toEqual([]);
  });

  it('identifies CRC16/Modbus in the wire order (low byte first)', () => {
    const report = checksumCandidates(observations);
    const candidate = report.candidates[0];

    expect(candidate).toMatchObject({
      algorithm: 'crc16-modbus',
      position: 5,
      width: 2,
      endian: 'le',
      coveredFrom: 0,
      coveredTo: 4,
      confidence: 1,
    });
    expect(candidate?.counterexamples).toEqual([]);
  });
});

describe('NexIoT Modbus write-single-register request', () => {
  const values = [1, 10, 500, 4096, 65535];
  const observations: Observation[] = values.map((value, index) => ({
    frameId: `w${index + 1}`,
    vars: { value },
    bytes: buildWriteSingle(1, 0x0010, value),
  }));

  it('finds the value at offset 4 and leaves the constant address alone', () => {
    expect(variableOffsets(observations)).toEqual([4, 5, 6, 7]);

    const field = inferFields(observations).fields.find((candidate) => candidate.variable === 'value');
    expect(field).toMatchObject({ offset: 4, type: 'u16', endian: 'be', confidence: 1 });
  });

  it('locates CRC at position 6', () => {
    const candidate = checksumCandidates(observations).candidates[0];
    expect(candidate).toMatchObject({ algorithm: 'crc16-modbus', position: 6, width: 2, endian: 'le' });
  });
});

describe('NexIoT Modbus multi-register response', () => {
  const baseline = [1, 2, 0, 4];
  const values = [10, 300, 1000, 4096, 65535];
  const observations: Observation[] = values.map((value, index) => {
    const registers = [...baseline];
    registers[2] = value;
    return { frameId: `mr${index + 1}`, vars: { register2: value }, bytes: buildReadHoldingResponse(1, registers) };
  });

  it('separates the varying register from constant neighbours', () => {
    expect(variableOffsets(observations)).toEqual([7, 8, 11, 12]);

    const field = inferFields(observations).fields.find((candidate) => candidate.variable === 'register2');
    expect(field).toMatchObject({ offset: 7, type: 'u16', endian: 'be', confidence: 1 });
  });

  it('locates the CRC after the last register', () => {
    const candidate = checksumCandidates(observations).candidates[0];
    expect(candidate).toMatchObject({ algorithm: 'crc16-modbus', position: 11, width: 2, endian: 'le' });
  });
});

describe('endianness control', () => {
  it('follows the bytes instead of assuming big-endian', () => {
    const littleEndian: Observation[] = VALUES.map((value, index) => {
      const pdu = Buffer.alloc(5);
      pdu.writeUInt8(1, 0);
      pdu.writeUInt8(0x03, 1);
      pdu.writeUInt8(2, 2);
      pdu.writeUInt16LE(value, 3);
      const crc = crc16ModbusRef(pdu);
      return {
        frameId: `le${index + 1}`,
        vars: { register: value },
        bytes: Buffer.concat([pdu, Buffer.from([crc & 0xff, crc >>> 8])]),
      };
    });

    const field = inferFields(littleEndian).fields.find((candidate) => candidate.variable === 'register');
    expect(field).toMatchObject({ offset: 3, type: 'u16', endian: 'le', confidence: 1 });
  });
});

describe('framework workflows on the NexIoT frames', () => {
  async function writeObservations(observations: Observation[]): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-nexiot-'));
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

  it('verifies spec-derived claims and rejects the wrong endianness claim', async () => {
    const file = await writeObservations(singleRegisterObservations(VALUES));
    const hypotheses = [
      {
        id: 'register-be',
        kind: 'field_semantics' as const,
        claim: 'register value is u16 big-endian at offset 3',
        evidenceRefs: [],
        checks: [
          { verifier: 'type_fit', args: { offset: 3, width: 2, type: 'u16', endian: 'be', variable: 'register' } },
        ],
      },
      {
        id: 'register-le',
        kind: 'field_semantics' as const,
        claim: 'register value is u16 little-endian at offset 3',
        evidenceRefs: [],
        checks: [
          { verifier: 'type_fit', args: { offset: 3, width: 2, type: 'u16', endian: 'le', variable: 'register' } },
        ],
      },
      {
        id: 'crc-coverage',
        kind: 'checksum' as const,
        claim: 'CRC16/Modbus covers bytes 0..4 and is stored low-byte-first at 5',
        evidenceRefs: [],
        checks: [
          {
            verifier: 'checksum_coverage',
            args: { algorithm: 'crc16-modbus', position: 5, width: 2, endian: 'le', coveredFrom: 0, coveredTo: 4 },
          },
        ],
      },
      {
        id: 'vibes',
        kind: 'other' as const,
        claim: 'this protocol looks plausible',
        evidenceRefs: [],
        checks: [{ verifier: 'llm_judge', args: {} }],
      },
    ];

    const result = await verifyHypotheses({ path: file, hypotheses });

    expect(result.summary).toEqual({ verified: 2, rejected: 1, unverified: 1 });
    expect(result.verdicts.map((verdict) => verdict.status)).toEqual([
      'verified',
      'rejected',
      'verified',
      'unverified',
    ]);
  });

  it('drafts a Kaitai schema that matches the recovered layout', async () => {
    const file = await writeObservations(singleRegisterObservations(VALUES));
    const draft = await diffFrames({ path: file });
    const rendered = renderKaitai(draft, { id: 'nexiot-modbus-read-holding' });

    expect(rendered.text).toContain('- id: reserved_0\n    size: 3');
    expect(rendered.text).toContain('- id: register\n    type: u2be');
    expect(rendered.text).toContain('- id: checksum_crc16_modbus\n    type: u2le');
    expect(rendered.id).toBe('nexiot_modbus_read_holding');
  });
});
