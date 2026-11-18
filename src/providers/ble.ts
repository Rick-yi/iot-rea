/**
 * BLE ATT adapter.
 *
 * Reads recorded HCI/btsnoop captures through TShark, keeps only ATT payloads,
 * and maps handle + opcode to a channel and a direction. It never opens a
 * Bluetooth adapter and never assumes which side is the device unless the caller
 * supplies a peer address.
 */
import type { Evidence } from '../contracts/evidence.js';
import type { Frame, Direction } from '../domain/frame.js';
import { normalizeHex, toRow, type FrameRow } from '../domain/frame.js';
import { attChannel, bleDirection } from '../domain/ble.js';
import { inspectPacketCapture, type TsharkRow } from './tshark.js';

export const BLE_FIELDS = [
  'frame.time_epoch',
  'btatt.handle',
  'btatt.opcode',
  'btatt.value',
  'bthci_acl.src.bd_addr',
  'bthci_acl.dst.bd_addr',
];

export interface BleRequest {
  path: string;
  peerAddress?: string;
  displayFilter?: string;
  packetLimit?: number;
}

export interface BleStats {
  rows: number;
  attFrames: number;
  controlFrames: number;
  skippedNoValue: number;
  unknownDirection: number;
}

export interface BleAssembly {
  frames: Frame[];
  stats: BleStats;
  unknowns: string[];
}

export interface BleFramesPage extends BleAssembly {
  rows: FrameRow[];
  evidence: Evidence;
}

export function rowsToBleFrames(rows: TsharkRow[], peerAddress?: string): BleAssembly {
  const frames: Frame[] = [];
  const stats: BleStats = {
    rows: rows.length,
    attFrames: 0,
    controlFrames: 0,
    skippedNoValue: 0,
    unknownDirection: 0,
  };

  for (const row of rows) {
    const hex = normalizeHex(row.fields['btatt.value']);
    if (hex === null) {
      stats.skippedNoValue += 1;
      continue;
    }

    const handle = row.fields['btatt.handle'];
    const channel = attChannel(handle);
    if (handle === undefined) stats.controlFrames += 1;

    const direction: Direction = bleDirection({
      opcode: row.fields['btatt.opcode'],
      srcAddress: row.fields['bthci_acl.src.bd_addr'],
      dstAddress: row.fields['bthci_acl.dst.bd_addr'],
      peerAddress,
    });
    if (direction === 'unknown') stats.unknownDirection += 1;

    stats.attFrames += 1;
    frames.push({
      index: frames.length + 1,
      nativeId: String(row.frameNumber),
      timestampMs: epochToMs(row.fields['frame.time_epoch']),
      direction,
      channel,
      bytes: Buffer.from(hex, 'hex'),
    });
  }

  const unknowns: string[] = [];
  if (stats.skippedNoValue > 0) {
    unknowns.push(`${stats.skippedNoValue} ATT frame(s) had no btatt.value and were omitted`);
  }
  if (stats.controlFrames > 0) {
    unknowns.push(
      `${stats.controlFrames} frame(s) carry no attribute handle and were assigned to channel att:control`,
    );
  }
  if (stats.unknownDirection > 0) {
    unknowns.push(
      `${stats.unknownDirection} frame(s) have an unknown direction; pass peerAddress or use a capture that keeps HCI addresses`,
    );
  }
  if (rows.length === 0) {
    unknowns.push('no ATT frame matched the selected filter; this does not prove absence outside that scope');
  }

  return { frames, stats, unknowns };
}

export async function inspectBleCapture(request: BleRequest): Promise<BleFramesPage> {
  const filter =
    request.displayFilter === undefined || request.displayFilter.trim() === ''
      ? 'btatt'
      : `btatt && (${request.displayFilter})`;

  const page = await inspectPacketCapture({
    path: request.path,
    fields: BLE_FIELDS,
    displayFilter: filter,
    packetLimit: request.packetLimit,
    matchLimit: null,
  });

  const assembled = rowsToBleFrames(page.rows, request.peerAddress);

  const limitations = [
    ...(page.evidence.limitations ?? []),
    'direction is derived from ATT opcode when no peer address is supplied; that assumes the central is the host',
    'only ATT payloads are normalized; LL/L2CAP control frames are excluded by the btatt filter',
    ...assembled.unknowns,
  ];

  return {
    ...assembled,
    rows: assembled.frames.map(toRow),
    evidence: { ...page.evidence, limitations },
  };
}

function epochToMs(value: string | string[] | undefined): number | null {
  if (value === undefined) return null;
  const text = Array.isArray(value) ? (value[0] ?? '') : value;
  const seconds = Number(text);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}
