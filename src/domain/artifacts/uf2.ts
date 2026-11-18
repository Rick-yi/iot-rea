/**
 * UF2 (USB Flashing Format) inventory.
 *
 * Recognition requires the first 512 bytes to be a complete block with all
 * three magic numbers. Families are separate address spaces, so the same
 * address may exist once per family. Gaps are never filled.
 */
import { IotReaError } from '../../contracts/errors.js';
import type { ArtifactImage, ArtifactInventory } from './types.js';
import { regionName } from './types.js';

const UF2_MAGIC_START0 = 0x0a324655;
const UF2_MAGIC_START1 = 0x9e5d5157;
const UF2_MAGIC_END = 0x0ab16f30;
const BLOCK_SIZE = 512;
const FLAG_FAMILY_ID_PRESENT = 0x2000;

/** Copied from microsoft/uf2 uf2families.json; unknown IDs stay null. */
const FAMILY_NAMES: Record<number, string> = {
  0x1b57745f: 'NRF52',
  0x1c5f21b0: 'ESP32',
  0x7eab61ed: 'ESP8266',
  0xbfdd4eee: 'ESP32S2',
  0xc47e5767: 'ESP32S3',
  0xd42ba06c: 'ESP32C3',
  0x2b88d29c: 'ESP32C2',
  0x332726f6: 'ESP32H2',
  0x540ddf62: 'ESP32C6',
  0x3d308e94: 'ESP32P4',
  0xf71c0343: 'ESP32C5',
  0x77d850c4: 'ESP32C61',
  0xb6dd00af: 'ESP32H21',
  0x9e0baa8a: 'ESP32H4',
  0x3101f7c1: 'ESP32S31',
  0xada52840: 'NRF52840',
  0x621e937a: 'NRF52833',
  0x68ed2b88: 'SAMD21',
  0x55114460: 'SAMD51',
  0x57755a57: 'STM32F4',
  0x9fffd543: 'RTL8710A',
  0x22e0d6fc: 'RTL8710B',
  0xe08f7564: 'RTL8720C',
  0x3379cfe2: 'RTL8720D',
  0x7b3ef230: 'BK7231N',
  0x675a40b0: 'BK7231U',
  0x6a82cc42: 'BK7251',
  0xde1270b7: 'BL602',
  0xe48bff56: 'RP2040',
  0xe48bff59: 'RP2350_ARM_S',
  0xe48bff5a: 'RP2350_RISCV',
  0xe48bff5b: 'RP2350_ARM_NS',
};

export interface Uf2Block {
  flags: number;
  targetAddress: number;
  payloadSize: number;
  blockNo: number;
  numBlocks: number;
  familyId: number | null;
  data: Buffer;
}

export function isUf2(bytes: Buffer): boolean {
  if (bytes.length < BLOCK_SIZE || bytes.length % BLOCK_SIZE !== 0) return false;
  return (
    bytes.readUInt32LE(0) === UF2_MAGIC_START0 &&
    bytes.readUInt32LE(4) === UF2_MAGIC_START1 &&
    bytes.readUInt32LE(508) === UF2_MAGIC_END
  );
}

export function parseUf2Blocks(bytes: Buffer): Uf2Block[] {
  const blocks: Uf2Block[] = [];
  for (let offset = 0; offset + BLOCK_SIZE <= bytes.length; offset += BLOCK_SIZE) {
    const flags = bytes.readUInt32LE(offset + 8);
    const targetAddress = bytes.readUInt32LE(offset + 12);
    const payloadSize = bytes.readUInt32LE(offset + 16);
    if (payloadSize > 476) {
      throw new IotReaError('unsupported_input', `UF2 block at ${offset} declares ${payloadSize} payload bytes`, {
        offset,
        payloadSize,
      });
    }
    const familyId = (flags & FLAG_FAMILY_ID_PRESENT) !== 0 ? bytes.readUInt32LE(offset + 28) : null;
    blocks.push({
      flags,
      targetAddress,
      payloadSize,
      blockNo: bytes.readUInt32LE(offset + 20),
      numBlocks: bytes.readUInt32LE(offset + 24),
      familyId,
      data: bytes.subarray(offset + 32, offset + 32 + payloadSize),
    });
  }
  return blocks;
}

export function inspectUf2(bytes: Buffer): ArtifactImage {
  const blocks = parseUf2Blocks(bytes);
  const grouped = new Map<string, { familyId: number | null; blocks: Uf2Block[] }>();

  for (const block of blocks) {
    const key = block.familyId === null ? 'no-family' : `family-0x${block.familyId.toString(16)}`;
    const group = grouped.get(key) ?? { familyId: block.familyId, blocks: [] };
    group.blocks.push(block);
    grouped.set(key, group);
  }

  const regions: ArtifactInventory['regions'] = [];
  const regionBytes = new Map<string, Buffer>();
  const unknowns: string[] = [];

  for (const [key, group] of grouped) {
    const sorted = [...group.blocks].sort((a, b) => a.targetAddress - b.targetAddress);
    let run: Uf2Block[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const start = run[0]?.targetAddress ?? 0;
      const last = run[run.length - 1] as Uf2Block;
      const end = last.targetAddress + last.payloadSize - 1;
      const path = regionName(start, end, key);
      const data = Buffer.concat(run.map((block) => block.data));
      regions.push({
        path,
        startAddress: start,
        endAddress: end,
        length: data.length,
        metadata: {
          familyId: group.familyId,
          familyName: group.familyId === null ? null : (FAMILY_NAMES[group.familyId] ?? null),
          blockCount: run.length,
          firstFileBlock: run[0]?.blockNo ?? null,
          lastFileBlock: last.blockNo,
        },
      });
      regionBytes.set(path, data);
      run = [];
    };

    for (const block of sorted) {
      const previous = run[run.length - 1];
      if (previous !== undefined && block.targetAddress !== previous.targetAddress + previous.payloadSize) {
        flush();
      }
      run.push(block);
    }
    flush();
  }

  if (blocks.some((block) => block.familyId === null)) {
    unknowns.push(
      'blocks without the familyID flag are grouped under no-family; family identity is not established for them',
    );
  }

  return {
    inventory: {
      format: 'uf2',
      size: bytes.length,
      regions,
      metadata: {
        blockCount: blocks.length,
        declaredBlocks: blocks[0]?.numBlocks ?? null,
        familyNames: 'partial table; unknown IDs keep familyName null',
      },
      unknowns,
    },
    regionBytes,
  };
}
