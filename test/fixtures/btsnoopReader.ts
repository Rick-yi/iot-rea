/**
 * Minimal btsnoop reader for tests: counts ATT PDUs and handles.
 *
 * Supports H4 (datalink 1002) and H1 (1001). Linux monitor captures (2001)
 * are reported but not decoded; TShark handles those.
 */
import { readFileSync } from 'node:fs';

export interface BtsnoopSummary {
  datalink: number;
  records: number;
  acl: number;
  att: number;
  opcodes: Record<number, number>;
  handles: Record<number, number>;
}

export function readBtsnoopAtt(file: string): BtsnoopSummary {
  const buffer = readFileSync(file);
  if (buffer.toString('ascii', 0, 8) !== 'btsnoop\0') throw new Error('not a btsnoop file');
  const datalink = buffer.readUInt32BE(12);
  const summary: BtsnoopSummary = { datalink, records: 0, acl: 0, att: 0, opcodes: {}, handles: {} };

  if (datalink !== 1001 && datalink !== 1002) return summary;

  let offset = 16;
  while (offset + 24 <= buffer.length) {
    const included = buffer.readUInt32BE(offset + 4);
    let data = buffer.subarray(offset + 24, offset + 24 + included);
    offset += 24 + included;
    if (data.length < included) break;
    summary.records += 1;

    if (datalink === 1002) {
      const packetType = data[0];
      data = data.subarray(1);
      if (packetType !== 0x02) continue;
    }
    summary.acl += 1;
    if (data.length < 8) continue;

    const aclLength = data.readUInt16LE(2);
    const payload = data.subarray(4, 4 + Math.min(aclLength, data.length - 4));
    if (payload.length < 5) continue;
    if (payload.readUInt16LE(2) !== 0x0004) continue; // L2CAP CID ATT

    const attLength = payload.readUInt16LE(0);
    const att = payload.subarray(4, 4 + attLength);
    if (att.length < 3) continue;

    const opcode = att[0] ?? 0;
    summary.att += 1;
    summary.opcodes[opcode] = (summary.opcodes[opcode] ?? 0) + 1;
    if (attLength >= 3) {
      const handle = att.readUInt16LE(1);
      summary.handles[handle] = (summary.handles[handle] ?? 0) + 1;
    }
  }

  return summary;
}