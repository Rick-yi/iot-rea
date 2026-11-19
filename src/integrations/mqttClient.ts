/**
 * Minimal MQTT 3.1.1 client: CONNECT, PUBLISH (QoS 0/1), PUBACK, DISCONNECT.
 *
 * Deliberately small: no subscriptions, no retained sessions, no reconnect.
 * The publisher is a short-lived bridge, and keeping the protocol surface
 * small keeps the failure modes reviewable.
 */
import net from 'node:net';
import tls from 'node:tls';

export interface MqttConnectOptions {
  url: string;
  clientId: string;
  username?: string;
  password?: string;
  keepaliveSeconds?: number;
  timeoutMs?: number;
  /** Only for mqtts://; defaults to true. */
  rejectUnauthorized?: boolean;
}

export interface PublishOptions {
  topic: string;
  payload: Buffer | string;
  qos?: 0 | 1;
  retain?: boolean;
}

export function encodeRemainingLength(length: number): Buffer {
  if (length < 0 || length > 268_435_455) throw new Error(`invalid MQTT remaining length: ${length}`);
  const bytes: number[] = [];
  let value = length;
  do {
    let encoded = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) encoded |= 0x80;
    bytes.push(encoded);
  } while (value > 0);
  return Buffer.from(bytes);
}

export function encodeConnect(options: {
  clientId: string;
  username?: string;
  password?: string;
  keepaliveSeconds?: number;
}): Buffer {
  const keepalive = options.keepaliveSeconds ?? 60;
  let flags = 0x02; // clean session
  const payloadParts: Buffer[] = [encodeString(options.clientId)];
  if (options.username !== undefined) {
    flags |= 0x80;
    payloadParts.push(encodeString(options.username));
    if (options.password !== undefined) {
      flags |= 0x40;
      payloadParts.push(encodeString(options.password));
    }
  }

  const variableHeader = Buffer.concat([
    encodeString('MQTT'),
    Buffer.from([0x04, flags, (keepalive >> 8) & 0xff, keepalive & 0xff]),
  ]);
  const payload = Buffer.concat(payloadParts);
  const body = Buffer.concat([variableHeader, payload]);
  return Buffer.concat([Buffer.from([0x10]), encodeRemainingLength(body.length), body]);
}

export function encodePublish(options: PublishOptions & { packetId?: number }): Buffer {
  const qos = options.qos ?? 0;
  const payload = Buffer.isBuffer(options.payload) ? options.payload : Buffer.from(options.payload, 'utf8');
  const topic = encodeString(options.topic);
  const packetId =
    qos === 0 ? Buffer.alloc(0) : Buffer.from([((options.packetId ?? 1) >> 8) & 0xff, (options.packetId ?? 1) & 0xff]);
  const body = Buffer.concat([topic, packetId, payload]);
  const header = 0x30 | ((qos & 0x03) << 1) | (options.retain === true ? 0x01 : 0);
  return Buffer.concat([Buffer.from([header]), encodeRemainingLength(body.length), body]);
}

export const DISCONNECT_PACKET = Buffer.from([0xe0, 0x00]);

export function encodeString(value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  if (body.length > 0xffff) throw new Error('MQTT string exceeds 65535 bytes');
  return Buffer.concat([Buffer.from([(body.length >> 8) & 0xff, body.length & 0xff]), body]);
}

interface Pending {
  resolve: (packet: Buffer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class MqttClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private pending: Pending[] = [];
  private nextPacketId = 1;
  private closed = false;

  async connect(options: MqttConnectOptions): Promise<void> {
    const url = new URL(options.url);
    if (url.protocol !== 'mqtt:' && url.protocol !== 'mqtts:') {
      throw new Error(`unsupported MQTT URL: ${options.url}`);
    }
    const secure = url.protocol === 'mqtts:';
    const port = url.port === '' ? (secure ? 8883 : 1883) : Number(url.port);
    const timeoutMs = options.timeoutMs ?? 10_000;

    this.socket = secure
      ? tls.connect({
          host: url.hostname,
          port,
          servername: url.hostname,
          rejectUnauthorized: options.rejectUnauthorized ?? true,
        })
      : net.connect({ host: url.hostname, port });

    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('error', (error: Error) => this.failAll(error));
    this.socket.on('close', () => {
      this.closed = true;
      this.failAll(new Error('MQTT connection closed'));
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MQTT connect timeout')), timeoutMs);
      this.socket?.once(secure ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.socket.write(
      encodeConnect({
        clientId: options.clientId,
        username: options.username,
        password: options.password,
        keepaliveSeconds: options.keepaliveSeconds,
      }),
    );

    const connack = await this.waitFor((packet) => packet[0] === 0x20, timeoutMs);
    const returnCode = connack[3] ?? 0xff;
    if (returnCode !== 0) throw new Error(`MQTT broker rejected the connection (return code ${returnCode})`);
  }

  async publish(options: PublishOptions): Promise<void> {
    if (this.socket === null || this.closed) throw new Error('MQTT client is not connected');
    const qos = options.qos ?? 0;
    const packetId = qos === 0 ? undefined : this.nextPacketId++;
    if (packetId !== undefined && packetId > 0xffff) this.nextPacketId = 1;

    const packet = encodePublish({ ...options, packetId });
    if (qos === 0) {
      this.socket.write(packet);
      return;
    }

    const expectedId = packetId ?? 0;
    const ack = this.waitFor(
      (incoming) =>
        incoming[0] === 0x40 &&
        incoming.length >= 4 &&
        ((incoming[2] ?? 0) << 8 | (incoming[3] ?? 0)) === expectedId,
      10_000,
    );
    this.socket.write(packet);
    await ack;
  }

  async end(): Promise<void> {
    if (this.socket === null) return;
    this.socket.write(DISCONNECT_PACKET);
    await new Promise<void>((resolve) => {
      this.socket?.once('close', () => resolve());
      this.socket?.end();
      setTimeout(() => resolve(), 1000).unref();
    });
    this.socket = null;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const parsed = decodePacket(this.buffer);
      if (parsed === null) return;
      this.buffer = this.buffer.subarray(parsed.totalLength);
      const handler = this.pending.shift();
      if (handler === undefined) continue;
      clearTimeout(handler.timer);
      handler.resolve(parsed.packet);
    }
  }

  private waitFor(match: (packet: Buffer) => boolean, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MQTT packet timeout')), timeoutMs);
      this.pending.push({
        resolve: (packet) => {
          if (match(packet)) resolve(packet);
          else reject(new Error('unexpected MQTT packet'));
        },
        reject,
        timer,
      });
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

/** Parse one MQTT packet from the front of the buffer, or null if incomplete. */
export function decodePacket(buffer: Buffer): { packet: Buffer; totalLength: number } | null {
  if (buffer.length < 2) return null;
  let multiplier = 1;
  let length = 0;
  let index = 1;
  for (;;) {
    if (index >= buffer.length) return null;
    const byte = buffer[index] ?? 0;
    length += (byte & 0x7f) * multiplier;
    index += 1;
    if ((byte & 0x80) === 0) break;
    multiplier *= 128;
    if (multiplier > 128 ** 3) throw new Error('malformed MQTT remaining length');
  }
  const totalLength = index + length;
  if (buffer.length < totalLength) return null;
  return { packet: buffer.subarray(0, totalLength), totalLength };
}