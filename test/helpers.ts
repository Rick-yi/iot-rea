/** Deterministic fixtures built in code; no binary blobs are committed. */
import type { Observation } from '../src/domain/diff.js';

export function sensorFrame(temperature: number, marker = 0xa1): Buffer {
  const head = Buffer.from([marker, 0x03, 0x00, 0x00]);
  const float = Buffer.alloc(4);
  float.writeFloatLE(temperature, 0);
  const body = Buffer.concat([head, float]);
  const sum = body.reduce((acc, byte) => (acc + byte) & 0xff, 0);
  return Buffer.concat([body, Buffer.from([sum])]);
}

export function sensorObservations(values: number[]): Observation[] {
  return values.map((value, index) => ({
    frameId: `f${index + 1}`,
    vars: { temperature: value },
    bytes: sensorFrame(value),
  }));
}

export interface Uf2BlockSpec {
  targetAddress: number;
  payload: Buffer;
  blockNo: number;
  numBlocks: number;
  familyId: number | null;
}

export function uf2Block(spec: Uf2BlockSpec): Buffer {
  const block = Buffer.alloc(512);
  block.writeUInt32LE(0x0a324655, 0);
  block.writeUInt32LE(0x9e5d5157, 4);
  block.writeUInt32LE(spec.familyId === null ? 0 : 0x2000, 8);
  block.writeUInt32LE(spec.targetAddress >>> 0, 12);
  block.writeUInt32LE(spec.payload.length, 16);
  block.writeUInt32LE(spec.blockNo, 20);
  block.writeUInt32LE(spec.numBlocks, 24);
  if (spec.familyId !== null) block.writeUInt32LE(spec.familyId >>> 0, 28);
  spec.payload.copy(block, 32);
  block.writeUInt32LE(0x0ab16f30, 508);
  return block;
}

export function ihexLine(type: number, address: number, data: Buffer): string {
  const bytes = [
    data.length,
    (address >> 8) & 0xff,
    address & 0xff,
    type,
    ...data,
  ];
  const sum = bytes.reduce((acc, byte) => (acc + byte) & 0xff, 0);
  const checksum = (0x100 - sum) & 0xff;
  const hex = [...bytes, checksum]
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join('');
  return `:${hex}`;
}

/** One Ethernet/IPv4/UDP packet in a little pcap container. */
export function tinyPcapUdp(payload: Buffer): Buffer {
  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0);
  ip.writeUInt16BE(20 + 8 + payload.length, 2);
  ip.writeUInt16BE(1, 4);
  ip.writeUInt8(64, 8);
  ip.writeUInt8(17, 9);
  ip.write('10.0.0.1', 12, 'ascii');
  ip.write('10.0.0.2', 16, 'ascii');
  const ipSum = onesComplement(ip);
  ip.writeUInt16BE(ipSum, 10);

  const udp = Buffer.alloc(8);
  udp.writeUInt16BE(50000, 0);
  udp.writeUInt16BE(9999, 2);
  udp.writeUInt16BE(8 + payload.length, 4);

  const ethernet = Buffer.alloc(14);
  ethernet.write('020304050607', 0, 'hex');
  ethernet.write('08090a0b0c0d', 6, 'hex');
  ethernet.writeUInt16BE(0x0800, 12);

  const frame = Buffer.concat([ethernet, ip, udp, payload]);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(65535, 16);
  header.writeUInt32LE(1, 20);

  const record = Buffer.alloc(16);
  record.writeUInt32LE(1763000000, 0);
  record.writeUInt32LE(0, 4);
  record.writeUInt32LE(frame.length, 8);
  record.writeUInt32LE(frame.length, 12);

  return Buffer.concat([header, record, frame]);
}

function onesComplement(buffer: Buffer): number {
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 2) {
    sum += (buffer[index] ?? 0) * 0x100 + (buffer[index + 1] ?? 0);
    sum = (sum & 0xffff) + (sum >> 16);
  }
  return ~sum & 0xffff;
}

export function minimalDfuse(body: Buffer): Buffer {
  const header = Buffer.from('DfuSe', 'ascii');
  const version = Buffer.from([1]);
  const suffix = Buffer.alloc(16);
  suffix.writeUInt16LE(0x0100, 0); // bcdDevice
  suffix.writeUInt16LE(0x0001, 2); // idProduct
  suffix.writeUInt16LE(0x0483, 4); // idVendor
  suffix.writeUInt16LE(0x011a, 6); // bcdDFU
  suffix.write('UFD', 8, 'ascii');
  suffix.writeUInt8(16, 11);
  suffix.writeUInt32LE(0x12345678, 12);
  return Buffer.concat([header, version, body, suffix]);
}
