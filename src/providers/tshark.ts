/**
 * TShark adapter: selected fields from an existing capture.
 *
 * It never opens an interface and never sees the caller's path. BLE recordings
 * (HCI/btsnoop) use the same field interface with btle and btatt fields; the
 * provider does not assume a link type.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { IotReaError } from '../contracts/errors.js';
import type { Evidence, OutputWindow } from '../contracts/evidence.js';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  privateCopy,
  probeVersion,
  resolveExecutable,
  runLimited,
  sha256File,
  verifyDigest,
} from './process.js';

const MAX_FIELDS = 1024;
const MAX_SELECTOR_CHARS = 8192;
const MAX_SELECTOR_TOTAL = 32 * 1024;

export interface TsharkRequest {
  path: string;
  fields?: string[];
  displayFilter?: string;
  decodeAs?: string[];
  /** Maximum input packets read before filtering. */
  packetLimit?: number;
  matchOffset?: number;
  matchLimit?: number | null;
  twoPass?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface TsharkRow {
  frameNumber: number;
  fields: Record<string, string | string[]>;
}

export interface TsharkPage {
  rows: TsharkRow[];
  window: OutputWindow;
  evidence: Evidence;
}

export function validateSelectors(fields: string[], decodeAs: string[]): void {
  if (fields.length > MAX_FIELDS) {
    throw new IotReaError('invalid_request', `at most ${MAX_FIELDS} fields are accepted`, {
      fields: fields.length,
    });
  }
  let total = 0;
  for (const selector of [...fields, ...decodeAs]) {
    if (selector.length > MAX_SELECTOR_CHARS) {
      throw new IotReaError('invalid_request', 'selector exceeds the per-selector length limit', {
        selectorChars: selector.length,
        limit: MAX_SELECTOR_CHARS,
      });
    }
    total += Buffer.byteLength(selector, 'utf8') + 8;
  }
  if (total > MAX_SELECTOR_TOTAL) {
    throw new IotReaError('invalid_request', 'selector arguments exceed the total budget', {
      bytes: total,
      limitBytes: MAX_SELECTOR_TOTAL,
    });
  }
}

export function buildTsharkArgs(request: TsharkRequest, capturePath: string): string[] {
  const fields = request.fields ?? ['frame.number'];
  const args = ['-r', capturePath, '-n', '-T', 'json'];
  for (const field of fields) args.push('-e', field);
  if (request.displayFilter !== undefined && request.displayFilter !== '') {
    args.push('-Y', request.displayFilter);
  }
  for (const rule of request.decodeAs ?? []) args.push('-d', rule);
  if (request.packetLimit !== undefined) args.push('-c', String(request.packetLimit));
  if (request.twoPass === true) args.push('-2');
  return args;
}

export async function inspectPacketCapture(request: TsharkRequest): Promise<TsharkPage> {
  const fields = request.fields ?? ['frame.number'];
  if (!fields.includes('frame.number')) fields.unshift('frame.number');
  validateSelectors(fields, request.decodeAs ?? []);

  const configured = process.env.IOT_REA_TSHARK;
  const { configuredPath, resolvedPath } = await resolveExecutable('tshark', configured);
  const versionBanner = await probeVersion(resolvedPath);
  const executableDigest = await sha256File(resolvedPath);

  const copy = await privateCopy(request.path);
  const configDir = path.join(path.dirname(copy.path), 'empty-wireshark-config');
  await mkdir(configDir, { recursive: true });

  const args = buildTsharkArgs({ ...request, fields }, copy.path);
  try {
    const outcome = await runLimited({
      command: resolvedPath,
      args,
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      env: {
        ...process.env,
        WIRESHARK_CONFIG_DIR: configDir,
        WIRESHARK_RUN_FROM_CLI: '1',
      },
    });

    if (outcome.exitCode !== 0) {
      const excerpt = outcome.stderr.trim().split(/\r?\n/)[0] ?? '';
      throw new IotReaError(
        'invalid_request',
        `tshark exited with ${outcome.exitCode ?? 'signal'}${excerpt === '' ? '' : `: ${excerpt}`}`,
        { exitCode: outcome.exitCode, signal: outcome.signal, stderr: outcome.stderr },
      );
    }

    const rows = parseTsharkJson(outcome.stdout, fields);
    const offset = request.matchOffset ?? 0;
    const limit = request.matchLimit === undefined ? 50 : request.matchLimit;
    const windowed = limit === null ? rows.slice(offset) : rows.slice(offset, offset + limit);
    const window: OutputWindow = {
      offset,
      requestedLimit: limit,
      total: rows.length,
      returned: windowed.length,
      hasMore: offset + windowed.length < rows.length,
    };

    await verifyDigest(copy.path, copy.digest, 'private capture copy');
    await verifyDigest(resolvedPath, executableDigest, 'tshark executable');

    return {
      rows: windowed.map((row) => ({
        frameNumber: toNumber(row['frame.number'] ?? row['frame.number.raw'] ?? '0'),
        fields: row,
      })),
      window,
      evidence: {
        source: { path: request.path, sha256: copy.digest, size: copy.size },
        tool: { configuredPath, resolvedPath, versionBanner, sha256: executableDigest },
        argv: args,
        stderr: outcome.stderr,
        warnings: outcome.stderr.trim() === '' ? undefined : [outcome.stderr.trim()],
        window,
        limitations: [
          'window.total counts matches inside the selected filter and packet limit only',
          'an empty page does not establish absence of matching traffic outside that scope',
        ],
      },
    };
  } finally {
    await copy.cleanup();
  }
}

export function parseTsharkJson(stdout: string, requestedFields: string[]): Array<Record<string, string | string[]>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout === '' ? '[]' : stdout);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('unreadable_output', `tshark JSON could not be parsed: ${message}`, {
      stderr: stdout.slice(0, 200),
    });
  }
  if (!Array.isArray(parsed)) {
    throw new IotReaError('unreadable_output', 'tshark did not return a JSON array');
  }

  const rows: Array<Record<string, string | string[]>> = [];
  for (const packet of parsed) {
    const layers = layerOf(packet);
    const row: Record<string, string | string[]> = {};
    for (const field of requestedFields) {
      const value = layers[field];
      if (value === undefined) continue;
      row[field] = flattenValue(value);
    }
    rows.push(row);
  }
  return rows;
}

function layerOf(packet: unknown): Record<string, unknown> {
  if (typeof packet !== 'object' || packet === null) return {};
  const source = (packet as Record<string, unknown>)['_source'];
  if (typeof source !== 'object' || source === null) return {};
  const layers = (source as Record<string, unknown>)['layers'];
  if (typeof layers !== 'object' || layers === null) return {};
  return layers as Record<string, unknown>;
}

function flattenValue(value: unknown): string | string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}

function toNumber(value: string | string[]): number {
  const text = Array.isArray(value) ? (value[0] ?? '0') : value;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
