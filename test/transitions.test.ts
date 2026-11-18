import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inferTransitions } from '../src/app/inferTransitions.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function framesFile(frames: unknown[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-transitions-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'frames.json');
  await writeFile(file, JSON.stringify(frames), 'utf8');
  return file;
}

const CYCLE = [
  { frameId: 't', direction: 'tx', channel: 'uart', hex: '0103000a' },
  { frameId: 'r', direction: 'rx', channel: 'uart', hex: '0103020014' },
];

describe('transition graph', () => {
  it('counts repeated request/response transitions and flags one-offs', async () => {
    const file = await framesFile([
      { ...CYCLE[0], frameId: 't1', timestampMs: 1 },
      { ...CYCLE[1], frameId: 'r1', timestampMs: 2 },
      { ...CYCLE[0], frameId: 't2', timestampMs: 3 },
      { ...CYCLE[1], frameId: 'r2', timestampMs: 4 },
      { ...CYCLE[0], frameId: 't3', timestampMs: 5 },
      { ...CYCLE[1], frameId: 'r3', timestampMs: 6 },
      { frameId: 't4', direction: 'tx', channel: 'uart', hex: '01060001', timestampMs: 7 },
      { frameId: 'r4', direction: 'rx', channel: 'uart', hex: '01060001', timestampMs: 8 },
    ]);

    const result = await inferTransitions({ path: file });

    expect(result.stats).toMatchObject({
      frames: 8,
      channels: 1,
      edges: 4,
      singleObservationEdges: 2,
      unknownDirection: 0,
    });
    expect(result.nodes.map((node) => node.id).sort()).toEqual([
      'uart|rx|01 03',
      'uart|rx|01 06',
      'uart|tx|01 03',
      'uart|tx|01 06',
    ]);
    const repeated = result.edges.find((edge) => edge.from === 'uart|tx|01 03' && edge.to === 'uart|rx|01 03');
    expect(repeated?.count).toBe(3);
    expect(result.unknowns.join(' ')).toContain('observed once');
    expect(result.mermaid).toContain('flowchart LR');
    expect(result.mermaid).toContain('-->|3|');
  });

  it('collapses different frames that share the signature prefix', async () => {
    const file = await framesFile([
      { frameId: 'a', direction: 'tx', channel: 'uart', hex: '0103000a' },
      { frameId: 'b', direction: 'rx', channel: 'uart', hex: '0103020014' },
      { frameId: 'c', direction: 'tx', channel: 'uart', hex: '01060001' },
      { frameId: 'd', direction: 'rx', channel: 'uart', hex: '01060001' },
    ]);

    const result = await inferTransitions({ path: file, signatureBytes: 1 });

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.find((node) => node.id === 'uart|tx|01')?.count).toBe(2);
    expect(result.unknowns.join(' ')).toContain('collapse');
  });

  it('filters by channel and reports single-frame channels', async () => {
    const file = await framesFile([
      { frameId: '1', direction: 'tx', channel: 'uart', hex: 'aa01' },
      { frameId: '2', direction: 'rx', channel: 'uart', hex: 'bb01' },
      { frameId: '3', direction: 'tx', channel: 'ble', hex: 'cc01' },
    ]);

    const uart = await inferTransitions({ path: file, channel: 'uart' });
    expect(uart.stats.frames).toBe(2);
    expect(uart.stats.channels).toBe(1);

    const all = await inferTransitions({ path: file });
    expect(all.unknowns.join(' ')).toContain('single frame');
  });

  it('orders by timestamp when available and says so when missing', async () => {
    const orderedFile = await framesFile([
      { frameId: 'r', direction: 'rx', channel: 'uart', hex: '0201', timestampMs: 10 },
      { frameId: 't', direction: 'tx', channel: 'uart', hex: '0101', timestampMs: 5 },
    ]);
    const ordered = await inferTransitions({ path: orderedFile });
    expect(ordered.edges[0]).toMatchObject({ from: 'uart|tx|01 01', to: 'uart|rx|02 01' });

    const noTime = await framesFile([
      { frameId: 'a', direction: 'tx', channel: 'uart', hex: '0101' },
      { frameId: 'b', direction: 'rx', channel: 'uart', hex: '0201' },
    ]);
    const unordered = await inferTransitions({ path: noTime });
    expect(unordered.unknowns.join(' ')).toContain('file order is assumed');
  });

  it('counts unknown directions without inventing them', async () => {
    const file = await framesFile([
      { frameId: 'x', channel: 'uart', hex: '0101' },
      { frameId: 'y', direction: 'tx', channel: 'uart', hex: '0201' },
    ]);

    const result = await inferTransitions({ path: file });

    expect(result.stats.unknownDirection).toBe(1);
    expect(result.unknowns.join(' ')).toContain('unknown direction');
  });
});
