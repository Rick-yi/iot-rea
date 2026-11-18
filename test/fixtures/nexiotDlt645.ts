/**
 * DL/T 645 transformations as documented by NexIoT's HexFunctions.
 *
 * Source (read-only reference, nothing executed):
 *   https://gitee.com/NexIoT/nexiot/blob/main/cn-universal-framework/
 *     cn-universal-core/src/main/java/cn/universal/core/engine/extend/HexFunctions.java
 *   cn-universal-core/src/main/java/cn/universal/core/engine/extend/ProtocolFunctions.java
 * Commit checked: 22072417fb51e6baa33ec0b895dddedbfac7b55d
 *
 * Rules taken from the upstream helpers:
 *   - data bytes are transmitted as value + 0x33, low 8 bits
 *   - the 12-digit meter address is padded, BCD-encoded and byte-reversed
 *   - data identifiers are byte-reversed
 *   - CS is the byte sum modulo the modulus (default 256), two hex digits
 *
 * The 68 ... 68 / 16 envelope follows the DL/T 645 standard; it is not
 * asserted by the upstream helper file, so the tests only rely on the
 * transformations and the checksum rule above.
 */
export const NEIXOT_HEX_SOURCE = {
  repo: 'https://gitee.com/NexIoT/nexiot',
  path: 'cn-universal-framework/cn-universal-core/src/main/java/cn/universal/core/engine/extend/HexFunctions.java',
  commit: '22072417fb51e6baa33ec0b895dddedbfac7b55d',
};

export function add0x33(bytes: Buffer): Buffer {
  return Buffer.from(bytes.map((byte) => (byte + 0x33) & 0xff));
}

export function sub0x33(bytes: Buffer): Buffer {
  return Buffer.from(bytes.map((byte) => (byte - 0x33) & 0xff));
}

export function reverseBytes(bytes: Buffer): Buffer {
  return Buffer.from([...bytes].reverse());
}

/** 12-digit address -> BCD -> byte-reversed, 6 bytes. */
export function encode645Address(digits: string): Buffer {
  const padded = digits.padStart(12, '0');
  if (!/^\d{12}$/.test(padded)) throw new Error('address must be 12 digits');
  const bcd: number[] = [];
  for (let index = 0; index < padded.length; index += 2) {
    bcd.push(Number.parseInt(`${padded[index + 1]}${padded[index]}`, 16));
  }
  return reverseBytes(Buffer.from(bcd));
}

/** Byte sum modulo the modulus, matching `cs_check` (default mod 256). */
export function csSum(bytes: Buffer, modulus = 256): number {
  const sum = bytes.reduce((acc, byte) => acc + byte, 0);
  return sum % modulus;
}

/** 8-digit decimal energy value -> 4-byte BCD, e.g. 1234 -> 00 00 12 34. */
export function bcd4(value: number): Buffer {
  const digits = value.toString().padStart(8, '0');
  if (digits.length !== 8) throw new Error('value must fit in 8 decimal digits');
  const out = Buffer.alloc(4);
  for (let index = 0; index < 4; index += 1) {
    out[index] = Number.parseInt(`${digits[index * 2]}${digits[index * 2 + 1]}`, 16);
  }
  return out;
}

/**
 * A DL/T 645 style read response for one energy value:
 *   68 addr(6) 68 C=0x91 L data(8) CS 16
 * data = reversed DI(4) + (BCD value + 0x33)(4)
 */
export function build645EnergyResponse(addressDigits: string, diHex: string, energy: number): Buffer {
  const addr = encode645Address(addressDigits);
  const di = reverseBytes(Buffer.from(diHex, 'hex'));
  const value = add0x33(bcd4(energy));
  const data = Buffer.concat([di, value]);

  const body = Buffer.concat([
    Buffer.from([0x68]),
    addr,
    Buffer.from([0x68, 0x91, data.length]),
    data,
  ]);

  const cs = csSum(body);
  return Buffer.concat([body, Buffer.from([cs, 0x16])]);
}
