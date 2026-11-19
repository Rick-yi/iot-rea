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
  it('extracts function codes and unit ids through TShark', async () => {
    const result = await inspectCapture({
      path: modbusPath as string,
      fields: ['frame.number', 'modbus.func_code', 'mbtcp.unit_id'],
      displayFilter: 'modbus',
      matchLimit: null,
    });

    expect(result.window.total).toBeGreaterThan(100);
    const codes = result.rows.flatMap((row) => {
      const value = row.fields['modbus.func_code'];
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    });
    expect(codes).toContain('3');
    expect(result.evidence.source.sha256).toHaveLength(64);
    expect(result.evidence.tool?.versionBanner).toContain('TShark');
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