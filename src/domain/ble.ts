/**
 * BLE ATT semantics.
 *
 * A capture gives handles and opcodes, not intent. This module maps those two
 * facts to a channel name and a direction, and records the assumption behind
 * the direction instead of hiding it: without a peer address, requests are
 * treated as host->device and notifications/indications as device->host.
 */
import type { Direction } from './frame.js';

export interface AttOpcodeInfo {
  name: string;
  /** Direction assuming the central (client) is the host. */
  direction: Direction;
  /** True when the opcode carries an attribute handle. */
  hasHandle: boolean;
}

const OPCODES: Record<number, AttOpcodeInfo> = {
  0x01: { name: 'error-response', direction: 'rx', hasHandle: true },
  0x02: { name: 'mtu-request', direction: 'tx', hasHandle: false },
  0x03: { name: 'mtu-response', direction: 'rx', hasHandle: false },
  0x04: { name: 'find-information-request', direction: 'tx', hasHandle: true },
  0x05: { name: 'find-information-response', direction: 'rx', hasHandle: true },
  0x06: { name: 'find-by-type-value-request', direction: 'tx', hasHandle: true },
  0x07: { name: 'find-by-type-value-response', direction: 'rx', hasHandle: true },
  0x08: { name: 'read-by-type-request', direction: 'tx', hasHandle: true },
  0x09: { name: 'read-by-type-response', direction: 'rx', hasHandle: true },
  0x0a: { name: 'read-request', direction: 'tx', hasHandle: true },
  0x0b: { name: 'read-response', direction: 'rx', hasHandle: true },
  0x0c: { name: 'read-blob-request', direction: 'tx', hasHandle: true },
  0x0d: { name: 'read-blob-response', direction: 'rx', hasHandle: true },
  0x0e: { name: 'read-multiple-request', direction: 'tx', hasHandle: true },
  0x0f: { name: 'read-multiple-response', direction: 'rx', hasHandle: false },
  0x10: { name: 'read-by-group-type-request', direction: 'tx', hasHandle: false },
  0x11: { name: 'read-by-group-type-response', direction: 'rx', hasHandle: true },
  0x12: { name: 'write-request', direction: 'tx', hasHandle: true },
  0x13: { name: 'write-response', direction: 'rx', hasHandle: true },
  0x16: { name: 'prepare-write-request', direction: 'tx', hasHandle: true },
  0x17: { name: 'prepare-write-response', direction: 'rx', hasHandle: true },
  0x18: { name: 'execute-write-request', direction: 'tx', hasHandle: false },
  0x19: { name: 'execute-write-response', direction: 'rx', hasHandle: false },
  0x1b: { name: 'handle-value-notification', direction: 'rx', hasHandle: true },
  0x1d: { name: 'handle-value-indication', direction: 'rx', hasHandle: true },
  0x1e: { name: 'handle-value-confirmation', direction: 'tx', hasHandle: true },
  0x20: { name: 'read-multiple-variable-request', direction: 'tx', hasHandle: true },
  0x21: { name: 'read-multiple-variable-response', direction: 'rx', hasHandle: false },
  0x23: { name: 'write-command', direction: 'tx', hasHandle: true },
  0xd2: { name: 'signed-write-command', direction: 'tx', hasHandle: true },
};

export function parseAttOpcode(value: string | string[] | undefined): number | null {
  if (value === undefined) return null;
  const text = Array.isArray(value) ? (value[0] ?? '') : value;
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '') return null;
  const parsed = trimmed.startsWith('0x') ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xff) return null;
  return parsed;
}

export function attOpcodeInfo(value: string | string[] | number | undefined): AttOpcodeInfo | null {
  const opcode = typeof value === 'number' ? value : parseAttOpcode(value);
  if (opcode === null) return null;
  return OPCODES[opcode] ?? null;
}

/** Normalize "0x12", "18" and "0x0012" to "0x0012". */
export function normalizeAttHandle(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const text = Array.isArray(value) ? (value[0] ?? '') : value;
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '') return null;
  const parsed = trimmed.startsWith('0x') ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xffff) return null;
  return `0x${parsed.toString(16).padStart(4, '0')}`;
}

export function attChannel(handle: string | string[] | undefined): string {
  const normalized = normalizeAttHandle(handle);
  return normalized === null ? 'att:control' : `att:${normalized}`;
}

/**
 * Direction precedence:
 *   1. HCI source/destination addresses vs the optional device address
 *   2. ATT opcode semantics (central assumed to be the host)
 *   3. unknown
 */
export function bleDirection(input: {
  opcode?: string | string[] | number;
  srcAddress?: string | string[] | undefined;
  dstAddress?: string | string[] | undefined;
  peerAddress?: string | undefined;
}): Direction {
  const src = addressOf(input.srcAddress);
  const dst = addressOf(input.dstAddress);
  const peer = addressOf(input.peerAddress);

  if (peer !== null && src !== null && dst !== null) {
    if (src === peer && dst !== peer) return 'rx';
    if (dst === peer && src !== peer) return 'tx';
  }

  const info = attOpcodeInfo(input.opcode);
  return info?.direction ?? 'unknown';
}

export function addressOf(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const text = Array.isArray(value) ? (value[0] ?? '') : value;
  const normalized = text.trim().toLowerCase().replace(/-/g, ':');
  return normalized === '' ? null : normalized;
}
