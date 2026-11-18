import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp/server.js';
import { MCP_TOOLS, toolByName } from '../src/mcp/tools.js';
import { sensorObservations } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: 'iot-rea-test', version: '1.0.0' });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

describe('tool definitions', () => {
  it('exposes unique, named tools with object input schemas', () => {
    const names = MCP_TOOLS.map((tool) => tool.name);
    expect(names).toEqual([
      'doctor',
      'inspect_capture',
      'diff_frames',
      'inspect_firmware',
      'decode_signals',
      'read_serial',
      'build_observations',
      'ble_frames',
      'export_ksy',
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.description.length).toBeGreaterThan(20);
    }
  });

  it('marks only filesystem-writing tools as non read-only', () => {
    expect(toolByName('export_ksy')?.readOnly).toBe(true);
    expect(toolByName('inspect_capture')?.readOnly).toBe(true);
    expect(toolByName('inspect_firmware')?.readOnly).toBe(false);
  });

  it('validates input before calling the handler', () => {
    expect(() => toolByName('decode_signals')?.inputSchema.parse({ path: 'x.vcd' })).toThrow();
    expect(toolByName('diff_frames')?.inputSchema.safeParse({ path: 'obs.json' }).success).toBe(true);
  });

  it('maps a targeted error to a structured tool failure', async () => {
    const output = await toolByName('inspect_firmware')?.run({ path: 'does/not/exist.uf2' });
    expect(output?.isError).toBe(true);
    const payload = JSON.parse(output?.content[0]?.text ?? '{}') as { code?: string };
    expect(payload.code).toBeDefined();
  });
});

describe('MCP protocol', () => {
  it('lists tools and calls doctor', async () => {
    const client = await connect();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain('inspect_capture');
    expect(listed.tools.find((tool) => tool.name === 'inspect_firmware')?.annotations?.readOnlyHint).toBe(false);
    expect(listed.tools.find((tool) => tool.name === 'export_ksy')?.annotations?.readOnlyHint).toBe(true);

    const result = await client.callTool({ name: 'doctor', arguments: {} });
    expect(result.isError).toBeUndefined();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const report = JSON.parse(text) as { node?: { supported?: boolean } };
    expect(report.node?.supported).toBe(true);
  });

  it('reads a serial recording end to end', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-mcp-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const log = path.join(dir, 'serial.log');
    await writeFile(log, '[2026-11-18T10:00:00.000Z] TX 01 03 00 00\nRX 01 03 04 00\n', 'utf8');

    const client = await connect();
    const result = await client.callTool({ name: 'read_serial', arguments: { path: log } });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? '{}') as {
      frames?: Array<{ direction: string }>;
      skippedLines?: number;
    };
    expect(body.frames).toHaveLength(2);
    expect(body.frames?.[0]?.direction).toBe('tx');
    expect(body.skippedLines).toBe(0);
  });

  it('drafts a Kaitai schema as text without writing files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-mcp-ksy-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'obs.json');
    const payload = sensorObservations([21.5, 22.25, 23]).map((obs) => ({
      frameId: obs.frameId,
      vars: obs.vars,
      hex: obs.bytes.toString('hex'),
    }));
    await writeFile(file, JSON.stringify(payload), 'utf8');

    const client = await connect();
    const result = await client.callTool({ name: 'export_ksy', arguments: { path: file, id: 'sensor' } });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? '{}') as {
      id?: string;
      text?: string;
      unknowns?: string[];
    };
    expect(body.id).toBe('sensor');
    expect(body.text).toContain('type: f4le');
    expect(body.text).toContain('checksum_sum8');
    expect((body.unknowns ?? []).length).toBeGreaterThan(0);
  });
});
