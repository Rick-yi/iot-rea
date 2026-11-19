import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportTelemetry } from '../src/app/exportTelemetry.js';
import { sensorObservations } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function writeObservations(payload: unknown[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-export-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'obs.json');
  await writeFile(file, JSON.stringify(payload), 'utf8');
  return file;
}

async function outDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-export-out-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('export-telemetry', () => {
  it('writes a field contract and normalized records without checksums', async () => {
    const file = await writeObservations(
      sensorObservations([21.5, 22.25, 23]).map((obs) => ({
        frameId: obs.frameId,
        vars: obs.vars,
        hex: obs.bytes.toString('hex'),
      })),
    );
    const dir = await outDir();
    const result = await exportTelemetry({
      path: file,
      deviceId: 'dev-1',
      outDir: dir,
      minConfidence: 1,
      tsBase: 1000,
      tsStep: 10,
      schemaVersion: '2',
    });

    const temperature = result.mapping.fields.find((field) => field.name === 'temperature');
    expect(temperature).toMatchObject({ offset: 4, width: 4, type: 'f32', endian: 'le', confidence: 1 });
    expect(result.mapping.checksums).toHaveLength(1);
    expect(result.mapping.derived).toEqual([]);

    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toMatchObject({
      deviceId: 'dev-1',
      ts: 1000,
      schemaVersion: '2',
      frameId: 'f1',
      quality: 'good',
    });
    expect(result.records[0]?.values['temperature']).toBeCloseTo(21.5, 3);
    expect(Object.keys(result.records[0]?.values ?? {})).toEqual(['temperature']);

    const jsonl = await readFile(result.telemetryPath, 'utf8');
    expect(jsonl.trim().split('\n')).toHaveLength(3);
  });

  it('marks a record partial when a labelled variable has no hypothesis', async () => {
    const payload = sensorObservations([21.5, 22.25, 23]).map((obs, index) => ({
      frameId: obs.frameId,
      vars: { temperature: obs.vars['temperature'], humidity: index + 1 },
      hex: obs.bytes.toString('hex'),
    }));
    const file = await writeObservations(payload);
    const dir = await outDir();

    const result = await exportTelemetry({ path: file, deviceId: 'dev-1', outDir: dir, minConfidence: 1 });

    expect(result.records.every((record) => record.quality === 'partial')).toBe(true);
    // The unexplained variable does not leak a fabricated value.
    expect(Object.keys(result.records[0]?.values ?? {})).toEqual(['temperature']);
  });

  it('excludes fields below the confidence threshold', async () => {
    const observations = sensorObservations([21.5, 22.25, 23]);
    // Break one label so the field hypothesis is only partial-confidence.
    const payload = observations.map((obs, index) => ({
      frameId: obs.frameId,
      vars: index === 2 ? { temperature: 9999 } : obs.vars,
      hex: obs.bytes.toString('hex'),
    }));
    const file = await writeObservations(payload);
    const dir = await outDir();

    const result = await exportTelemetry({ path: file, deviceId: 'dev-1', outDir: dir, minConfidence: 1 });

    expect(result.mapping.fields).toHaveLength(0);
    expect(result.records[0]?.quality).toBe('partial'); // labelled but nothing exported
  });
});