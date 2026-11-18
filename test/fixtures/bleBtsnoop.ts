/**
 * Synthetic btsnoop capture with HCI ACL / L2CAP / ATT payloads.
 *
 * This is NOT a recording from a real device. It exists to exercise the whole
 * BLE provider path through TShark in CI:
 *   btsnoop H4 -> HCI ACL -> L2CAP (CID 0x0004) -> ATT notification/write
 *
 * Format reference (Wireshark wiretap/btsnoop.c):
 *   header: "btsnoop\0", version 1, datalink 1002 (HCI UART / H4)
 *   record: orig_len, incl_len, flags, drops, timestamp (all big-endian,
 *           timestamp is signed 64-bit microseconds)
 *   flags: bit0 = controller->host, bit1 = command/event (0 for ACL data)
 *   H4 data starts with packet type 0x02 for ACL
 */
export const BTSNOOP_MAGIC = 'btsnoop\0';
export const BTSNOOP_DATALINK_H4 = 1002;

/** Symbian time base used by Wireshark to convert btsnoop timestamps to unix time. */
const KUNIX_TIME_BASE = 0x00dcddb30f2f8000n;
const EPOCH_US = 1_700_000_000_000_000n;

export interface BtRecord {
  /** true when the controller sent this packet to the host. */
  controllerToHost: boolean;
  /** HCI ACL payload after the 4-byte HCI header (L2CAP packet). */
  l2cap: Buffer;
}

function u32be(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function i64be(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64BE(value, 0);
  return buffer;
}

/** ATT Handle Value Notification (0x1b). */
export function attNotification(handle: number, value: Buffer): Buffer {
  const att = Buffer.alloc(3 + value.length);
  att.writeUInt8(0x1b, 0);
  att.writeUInt16LE(handle, 1);
  value.copy(att, 3);
  return l2capOf(att);
}

/** ATT Write Request (0x12). */
export function attWriteRequest(handle: number, value: Buffer): Buffer {
  const att = Buffer.alloc(3 + value.length);
  att.writeUInt8(0x12, 0);
  att.writeUInt16LE(handle, 1);
  value.copy(att, 3);
  return l2capOf(att);
}

function l2capOf(att: Buffer): Buffer {
  const l2cap = Buffer.alloc(4 + att.length);
  l2cap.writeUInt16LE(att.length, 0);
  l2cap.writeUInt16LE(0x0004, 2); // ATT fixed channel
  att.copy(l2cap, 4);
  return l2cap;
}

export function buildBtsnoop(records: BtRecord[]): Buffer {
  const header = Buffer.concat([
    Buffer.from(BTSNOOP_MAGIC, 'ascii'),
    u32be(1),
    u32be(BTSNOOP_DATALINK_H4),
  ]);

  const parts: Buffer[] = [header];
  let timestamp = KUNIX_TIME_BASE + EPOCH_US;

  records.forEach((record, index) => {
    // H4 packet type + HCI ACL header (handle with PB=first fragment, length).
    const hci = Buffer.alloc(5);
    hci.writeUInt8(0x02, 0);
    hci.writeUInt16LE(0x2000 | (index % 8), 1);
    hci.writeUInt16LE(record.l2cap.length, 3);
    const data = Buffer.concat([hci, record.l2cap]);

    const flags = record.controllerToHost ? 0x00000001 : 0x00000000;
    const recordHeader = Buffer.concat([
      u32be(data.length),
      u32be(data.length),
      u32be(flags),
      u32be(0),
      i64be(timestamp),
    ]);

    parts.push(recordHeader, data);
    timestamp += 1000n; // 1 ms between records
  });

  return Buffer.concat(parts);
}

/** Five frames: three notifications and two writes. */
export function sampleBleCapture(): Buffer {
  return buildBtsnoop([
    { controllerToHost: true, l2cap: attNotification(0x0012, Buffer.from([0x01, 0x02])) },
    { controllerToHost: true, l2cap: attNotification(0x0012, Buffer.from([0x01, 0x03])) },
    { controllerToHost: false, l2cap: attWriteRequest(0x0015, Buffer.from([0x0a])) },
    { controllerToHost: false, l2cap: attWriteRequest(0x0015, Buffer.from([0x0b])) },
    { controllerToHost: true, l2cap: attNotification(0x0012, Buffer.from([0x01, 0x04])) },
  ]);
}
