import { createServer, type Server, type Socket } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishTelemetry, renderTopic } from '../src/app/publishTelemetry.js';
import { MqttClient, decodePacket, encodeConnect, encodePublish } from '../src/integrations/mqttClient.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Broker {
  url: string;
  received: Array<{ topic: string; payload: string }>;
  close: () => Promise<void>;
}

function variableHeaderOffset(packet: Buffer): number {
  let index = 1;
  while ((packet[index] ?? 0) & 0x80) index += 1;
  return index + 1;
}

async function startBroker(): Promise<Broker> {
  const received: Array<{ topic: string; payload: string }> = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = decodePacket(buffer);
        if (parsed === null) return;
        buffer = buffer.subarray(parsed.totalLength);
        const packet = parsed.packet;
        const type = (packet[0] ?? 0) >> 4;

        if (type === 1) {
          socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00])); // CONNACK accepted
          continue;
        }
        if (type === 3) {
          const headerOffset = variableHeaderOffset(packet);
          const topicLength = packet.readUInt16BE(headerOffset);
          const topic = packet.toString('utf8', headerOffset + 2, headerOffset + 2 + topicLength);
          let cursor = headerOffset + 2 + topicLength;
          const qos = ((packet[0] ?? 0) >> 1) & 0x03;
          let packetId = 0;
          if (qos > 0) {
            packetId = packet.readUInt16BE(cursor);
            cursor += 2;
          }
          received.push({ topic, payload: packet.toString('utf8', cursor) });
          if (qos > 0) {
            socket.write(Buffer.from([0x40, 0x02, (packetId >> 8) & 0xff, packetId & 0xff]));
          }
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('broker did not bind');
  const broker: Broker = {
    url: `mqtt://127.0.0.1:${address.port}`,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  cleanups.push(broker.close);
  return broker;
}

async function telemetryFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-publish-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'telemetry.jsonl');
  const lines = [
    { deviceId: 'dev-1', ts: 1000, schemaVersion: '1', frameId: 'f1', values: { temperature: 21.5 }, quality: 'good' },
    { deviceId: 'dev-1', ts: 2000, schemaVersion: '1', frameId: 'f2', values: { temperature: 22.25 }, quality: 'good' },
  ];
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return file;
}

describe('MQTT packet encoding', () => {
  it('encodes CONNECT and PUBLISH packets', () => {
    expect(encodeConnect({ clientId: 'c1' }).toString('hex')).toBe('100e00044d5154540402003c00026331');
    expect(encodePublish({ topic: 't', payload: 'hi' }).toString('hex')).toBe('30050001746869');
    expect(encodePublish({ topic: 't', payload: 'hi', qos: 1, packetId: 1 }).toString('hex')).toBe(
      '320700017400016869',
    );
  });

  it('decodes only complete packets', () => {
    expect(decodePacket(Buffer.from([0x20, 0x02]))).toBeNull();
    expect(decodePacket(Buffer.from([0x20, 0x02, 0x00, 0x00]))?.totalLength).toBe(4);
  });
});

describe('MqttClient', () => {
  it('connects, publishes QoS 1 and disconnects against a mock broker', async () => {
    const broker = await startBroker();
    const client = new MqttClient();
    await client.connect({ url: broker.url, clientId: 'test-client' });
    await client.publish({ topic: 'devices/dev-1/telemetry', payload: '{"a":1}', qos: 1 });
    await client.end();

    expect(broker.received).toEqual([{ topic: 'devices/dev-1/telemetry', payload: '{"a":1}' }]);
  });
});

describe('publish-telemetry', () => {
  it('defaults to dry-run and renders the topic template', async () => {
    const file = await telemetryFile();
    const result = await publishTelemetry({ path: file, topic: 'devices/{deviceId}/telemetry' });

    expect(result.dryRun).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.topics).toEqual(['devices/dev-1/telemetry']);
    expect(result.messages).toHaveLength(2);
    expect(result.evidence.limitations?.join(' ')).toContain('dry-run');
  });

  it('sends values-mode payloads when --send is set', async () => {
    const broker = await startBroker();
    const file = await telemetryFile();
    const result = await publishTelemetry({
      path: file,
      topic: 'devices/{deviceId}/telemetry',
      broker: broker.url,
      send: true,
      payloadMode: 'values',
      qos: 1,
    });

    expect(result.sent).toBe(2);
    expect(broker.received).toHaveLength(2);
    expect(broker.received[0]?.topic).toBe('devices/dev-1/telemetry');
    expect(JSON.parse(broker.received[0]?.payload ?? '{}')).toEqual({
      ts: 1000,
      values: { temperature: 21.5 },
    });
  });

  it('refuses to send without a broker and rejects unknown placeholders', async () => {
    const file = await telemetryFile();
    await expect(publishTelemetry({ path: file, topic: 'devices/{deviceId}/telemetry', send: true })).rejects.toThrow(
      /--broker is required/,
    );

    expect(() =>
      renderTopic('devices/{unknown}', {
        deviceId: 'd',
        ts: 1,
        values: {},
        schemaVersion: '1',
      }),
    ).toThrow(/unknown topic placeholder/);
  });
});