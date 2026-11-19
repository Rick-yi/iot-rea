/**
 * Real capture regressions (fetched by CI, not committed).
 *
 * Sources (both MIT):
 *   - Modbus plant:  https://github.com/Cincosavvy/MODBUS-WATCH (samples/plant.pcap)
 *   - MQTT IoT set:  https://github.com/l-laura/MQTTset-reduced (benign.pcap)
 *
 * The Modbus capture is a plant testbed trace; the MQTT capture comes from the
 * MQTTset IoT dataset. Neither is from a device owned by this project, so these
 * tests assert dissection and evidence plumbing, not protocol semantics.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectCapture } from '../src/app/inspectCapture.js';

const modbusPath = process.env.IOT_REA_CAPTURE_MODBUS;
const mqttPath = process.env.IOT_REA_CAPTURE_MQTT;

function present(file: string | undefined): boolean {
  return file !== undefined && file !== '' && existsSync(file);
}

describe.skipIf(!present(modbusPath))('real Modbus capture', () => {
  it('reads the plant trace and engages the Modbus/TCP dissector', async () => {
    const transport = await inspectCapture({
      path: modbusPath as string,
      fields: ['frame.number', 'tcp.srcport', 'tcp.dstport'],
      displayFilter: 'tcp.port == 502',
      matchLimit: null,
    });
    expect(transport.window.total).toBeGreaterThan(100);
    expect(transport.evidence.source.sha256).toHaveLength(64);
    expect(transport.evidence.tool?.versionBanner).toContain('TShark');

    const protocol = await inspectCapture({
      path: modbusPath as string,
      fields: ['frame.number', 'modbus.func_code', 'mbtcp.unit_id'],
      displayFilter: 'mbtcp',
      matchLimit: null,
      twoPass: true,
    });
    // This plant trace is only partially dissected by TShark's Modbus/TCP
    // heuristics; the assertion records that the dissector engaged at all.
    expect(protocol.window.total).toBeGreaterThan(0);
  });
});

describe.skipIf(!present(mqttPath))('real MQTT capture', () => {
  it('extracts topics and message types through TShark', async () => {
    const result = await inspectCapture({
      path: mqttPath as string,
      fields: ['frame.number', 'mqtt.msgtype', 'mqtt.topic'],
      displayFilter: 'mqtt',
      matchLimit: null,
      // ~10k packets of pretty-printed TShark JSON exceed the 4 MiB default.
      maxOutputBytes: 16 * 1024 * 1024,
    });

    expect(result.window.total).toBeGreaterThan(100);
    const topics = result.rows.flatMap((row) => {
      const value = row.fields['mqtt.topic'];
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    });
    expect(topics.length).toBeGreaterThan(0);
    expect(result.evidence.source.sha256).toHaveLength(64);
  });
});