/**
 * Label files attach business values to captured frames.
 *
 * Supported shapes:
 *   CSV  - header row, first column frame/frameId/frame_number, rest are vars
 *   JSON - {"3": {"temperature": 21.5}} or [{"frameId": "3", "vars": {...}}]
 *
 * Values are typed conservatively: numeric -> number, true/false -> boolean,
 * everything else stays a string. Ambiguous rows are rejected, not guessed.
 */
import { IotReaError } from '../contracts/errors.js';

export type LabelValue = number | string | boolean;
export type LabelMap = Map<string, Record<string, LabelValue>>;

export function parseLabels(text: string, format: 'auto' | 'csv' | 'json' = 'auto'): LabelMap {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed === '') {
    throw new IotReaError('invalid_request', 'label file is empty');
  }

  const detected = format === 'auto' ? (trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : 'csv') : format;
  return detected === 'json' ? parseJsonLabels(trimmed) : parseCsvLabels(trimmed);
}

export function parseJsonLabels(text: string): LabelMap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `label JSON could not be parsed: ${message}`);
  }

  const map: LabelMap = new Map();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) {
        throw new IotReaError('invalid_request', 'label entries must be objects');
      }
      const record = entry as Record<string, unknown>;
      const frameId = frameIdOf(record);
      const vars = record['vars'];
      if (frameId === null || typeof vars !== 'object' || vars === null) {
        throw new IotReaError('invalid_request', 'label entries need frameId and vars');
      }
      map.set(frameId, coerceVars(vars as Record<string, unknown>));
    }
    return map;
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new IotReaError('invalid_request', 'label JSON must be an object or array');
  }
  for (const [frameId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new IotReaError('invalid_request', `labels for frame ${frameId} must be an object`);
    }
    map.set(frameId, coerceVars(value as Record<string, unknown>));
  }
  return map;
}

export function parseCsvLabels(text: string): LabelMap {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = splitCsv(lines[0] ?? '');
  if (header.length < 2) {
    throw new IotReaError('invalid_request', 'label CSV needs a frame column and at least one variable column');
  }
  const first = header[0]?.trim().toLowerCase();
  if (first !== 'frame' && first !== 'frameid' && first !== 'frame_number' && first !== 'framenumber') {
    throw new IotReaError('invalid_request', `label CSV first column must be frame/frameId, got "${header[0] ?? ''}"`);
  }

  const map: LabelMap = new Map();
  for (const [index, line] of lines.entries()) {
    if (index === 0) continue;
    const cells = splitCsv(line);
    if (cells.length !== header.length) {
      throw new IotReaError(
        'invalid_request',
        `label CSV line ${index + 1} has ${cells.length} cells, header has ${header.length}`,
      );
    }
    const frameId = (cells[0] ?? '').trim();
    if (frameId === '') {
      throw new IotReaError('invalid_request', `label CSV line ${index + 1} has an empty frame id`);
    }
    const vars: Record<string, LabelValue> = {};
    for (let cell = 1; cell < header.length; cell += 1) {
      const name = (header[cell] ?? '').trim();
      if (name === '') {
        throw new IotReaError('invalid_request', `label CSV header cell ${cell + 1} is empty`);
      }
      vars[name] = coerceValue(cells[cell] ?? '');
    }
    map.set(frameId, vars);
  }
  return map;
}

/** Minimal CSV split with double-quote support; embedded newlines are not supported. */
function splitCsv(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function coerceVars(vars: Record<string, unknown>): Record<string, LabelValue> {
  const coerced: Record<string, LabelValue> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value === 'number') {
      coerced[name] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      coerced[name] = value;
      continue;
    }
    if (typeof value === 'string') {
      coerced[name] = coerceValue(value);
      continue;
    }
    throw new IotReaError('invalid_request', `label "${name}" has an unsupported value type`);
  }
  return coerced;
}

function coerceValue(value: string): LabelValue {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return trimmed;
}

function frameIdOf(record: Record<string, unknown>): string | null {
  const value = record['frameId'] ?? record['frame'] ?? record['frame_number'];
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}
