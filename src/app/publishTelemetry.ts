/**
 * publish-telemetry: send exported records to an MQTT broker.
 *
 * Publishing is an explicit, separate action: dry-run is the default, the
 * broker comes from flags/env, and credentials are only read from env.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Evidence } from '../contracts/evidence.js';
import { IotReaError } from '../contracts/errors.js';
import { MqttClient } from '../integrations/mqttClient.js';
import { fileSize, sha256File } from '../providers/process.js';

export const publishTelemetryInputSchema = z.object({
  path: z.string().min(1),
  topic: z.string().min(1),
  broker: z.string().min(1).optional(),
  qos: z.union([z.literal(0), z.literal(1)]).optional(),
  rateMs: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
  payloadMode: z.enum(['record', 'values']).optional(),
  send: z.boolean().optional(),
  clientId: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  rejectUnauthorized: z.boolean().optional(),
});

export type PublishTelemetryInput = z.infer<typeof publishTelemetryInputSchema>;

const recordSchema = z.object({
  deviceId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  schemaVersion: z.string().optional(),
  frameId: z.string().optional(),
  values: z.record(z.union([z.number(), z.string()])),
  quality: z.string().optional(),
});

export type TelemetryMessage = { topic: string; payload: string; frameId?: string };

export interface PublishTelemetryResult {
  sent: number;
  dryRun: boolean;
  broker: string | null;
  topics: string[];
  messages: TelemetryMessage[];
  evidence: Evidence;
}

export function renderTopic(template: string, record: z.infer<typeof recordSchema>): string {
  const rendered = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    switch (key) {
      case 'deviceId':
        return record.deviceId;
      case 'schemaVersion':
        return record.schemaVersion ?? '';
      case 'frameId':
        return record.frameId ?? '';
      case 'quality':
        return record.quality ?? '';
      case 'ts':
        return String(record.ts);
      default:
        throw new IotReaError('invalid_request', `unknown topic placeholder {${key}}`);
    }
  });
  if (/\{[^}]+\}/.test(rendered)) {
    throw new IotReaError('invalid_request', `unresolved topic placeholder in "${rendered}"`);
  }
  return rendered;
}

export async function publishTelemetry(input: PublishTelemetryInput): Promise<PublishTelemetryResult> {
  const parsed = publishTelemetryInputSchema.parse(input);
  const payloadMode = parsed.payloadMode ?? 'record';
  const qos = parsed.qos ?? 1;
  const send = parsed.send ?? false;
  const rateMs = parsed.rateMs ?? 0;

  const size = await fileSize(parsed.path);
  const digest = await sha256File(parsed.path);
  let text: string;
  try {
    text = await readFile(parsed.path, 'utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `cannot read telemetry at ${parsed.path}: ${message}`);
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    throw new IotReaError('invalid_request', 'telemetry file has no records');
  }

  const records = lines.map((line, index) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new IotReaError('invalid_request', `telemetry line ${index + 1} is not valid JSON: ${message}`);
    }
    return recordSchema.parse(raw);
  });

  const selected = parsed.limit === undefined ? records : records.slice(0, parsed.limit);
  const messages: TelemetryMessage[] = selected.map((record) => ({
    topic: renderTopic(parsed.topic, record),
    payload:
      payloadMode === 'values'
        ? JSON.stringify({ ts: record.ts, values: record.values })
        : JSON.stringify(record),
    frameId: record.frameId,
  }));

  const evidence: Evidence = {
    source: { path: parsed.path, sha256: digest, size },
    limitations: [
      'publishing is opt-in and only sends to the broker you configure',
      'no retries, no reconnects and no retained-session handling in this bridge',
      'records are sent in file order; timestamps are whatever the export wrote',
      ...(send ? [] : ['dry-run: nothing was sent']),
    ],
  };

  if (!send) {
    return {
      sent: 0,
      dryRun: true,
      broker: parsed.broker ?? null,
      topics: [...new Set(messages.map((message) => message.topic))],
      messages,
      evidence,
    };
  }

  if (parsed.broker === undefined) {
    throw new IotReaError('invalid_request', '--broker is required when --send is set');
  }

  const client = new MqttClient();
  await client.connect({
    url: parsed.broker,
    clientId: parsed.clientId ?? `iot-rea-${Math.random().toString(16).slice(2, 10)}`,
    username: parsed.username,
    password: parsed.password,
    rejectUnauthorized: parsed.rejectUnauthorized,
  });

  try {
    for (const [index, message] of messages.entries()) {
      await client.publish({ topic: message.topic, payload: message.payload, qos });
      if (rateMs > 0 && index < messages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, rateMs));
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  return {
    sent: messages.length,
    dryRun: false,
    broker: parsed.broker,
    topics: [...new Set(messages.map((message) => message.topic))],
    messages,
    evidence: { ...evidence, limitations: evidence.limitations?.filter((item) => !item.startsWith('dry-run')) },
  };
}