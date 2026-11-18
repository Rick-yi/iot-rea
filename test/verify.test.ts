import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvidencePack } from '../src/app/advise.js';
import { loadHypothesisFile, verifyHypotheses } from '../src/app/verifyHypotheses.js';
import type { Hypothesis } from '../src/contracts/hypotheses.js';
import { verifyHypothesis } from '../src/domain/verify.js';
import { sensorObservations } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const SENSOR = sensorObservations([21.5, 22.25, 23.0, 19.75, 24.5]);

function claim(checks: Hypothesis['checks'], kind: Hypothesis['kind'] = 'field_semantics'): Hypothesis {
  return { id: 'h1', kind, claim: 'offset 0x04 is a little-endian f32 temperature', evidenceRefs: [], checks };
}

function scaleObservations(raws: number[]) {
  return raws.map((raw, index) => {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16LE(raw, 0);
    return { frameId: `s${index + 1}`, vars: { temperature: raw / 10 }, bytes };
  });
}

describe('type_fit', () => {
  it('verifies the f32 claim that the differential proposed', () => {
    const verdict = verifyHypothesis(
      claim([
        { verifier: 'type_fit', args: { offset: 4, width: 4, type: 'f32', endian: 'le', variable: 'temperature' } },
      ]),
      SENSOR,
    );

    expect(verdict.status).toBe('verified');
    expect(verdict.checks[0]).toMatchObject({ matched: 5, total: 5, counterexamples: [] });
  });

  it('rejects a wrong endian hypothesis with counterexamples', () => {
    const verdict = verifyHypothesis(
      claim([
        { verifier: 'type_fit', args: { offset: 4, width: 4, type: 'f32', endian: 'be', variable: 'temperature' } },
      ]),
      SENSOR,
    );

    expect(verdict.status).toBe('rejected');
    expect(verdict.checks[0]?.counterexamples.length).toBeGreaterThan(0);
    expect(verdict.checks[0]?.detail).toContain('contradicted');
  });

  it('supports a declared scale factor', () => {
    const observations = scaleObservations([215, 216, 217]);
    const verdict = verifyHypothesis(
      claim([{ verifier: 'type_fit', args: { offset: 0, width: 2, type: 'u16', endian: 'le', variable: 'temperature', factor: 10 } }], 'scaling'),
      observations,
    );

    expect(verdict.status).toBe('verified');
  });

  it('treats unparsable args as unsupported instead of a pass', () => {
    const verdict = verifyHypothesis(
      claim([{ verifier: 'type_fit', args: { offset: 'four', width: 4, type: 'f32', variable: 'temperature' } }]),
      SENSOR,
    );

    expect(verdict.status).toBe('unverified');
    expect(verdict.checks[0]?.status).toBe('unsupported');
  });
});

describe('checksum_coverage', () => {
  it('verifies the trailing sum8 over the frame prefix', () => {
    const verdict = verifyHypothesis(
      claim([
        {
          verifier: 'checksum_coverage',
          args: { algorithm: 'sum8', position: 8, width: 1, endian: 'be', coveredFrom: 0, coveredTo: 7 },
        },
      ], 'checksum'),
      SENSOR,
    );

    expect(verdict.status).toBe('verified');
    expect(verdict.checks[0]?.matched).toBe(5);
  });

  it('rejects a coverage range that omits the float bytes', () => {
    const verdict = verifyHypothesis(
      claim([
        {
          verifier: 'checksum_coverage',
          args: { algorithm: 'sum8', position: 8, width: 1, endian: 'be', coveredFrom: 0, coveredTo: 3 },
        },
      ], 'checksum'),
      SENSOR,
    );

    expect(verdict.status).toBe('rejected');
  });
});

describe('verdict semantics', () => {
  it('leaves unknown verifiers unverified, not rejected', () => {
    const verdict = verifyHypothesis(
      claim([{ verifier: 'llm_judge', args: { question: 'is this plausible?' } }]),
      SENSOR,
    );

    expect(verdict.status).toBe('unverified');
    expect(verdict.checks[0]?.detail).toContain('no verifier');
  });

  it('requires at least one check to be verified', () => {
    const verdict = verifyHypothesis(claim([]), SENSOR);
    expect(verdict.status).toBe('unverified');
    expect(verdict.checks).toHaveLength(0);
  });

  it('rejects a mixed set when one check contradicts', () => {
    const verdict = verifyHypothesis(
      claim([
        { verifier: 'type_fit', args: { offset: 4, width: 4, type: 'f32', endian: 'le', variable: 'temperature' } },
        { verifier: 'type_fit', args: { offset: 4, width: 4, type: 'u32', endian: 'le', variable: 'temperature' } },
      ]),
      SENSOR,
    );

    expect(verdict.status).toBe('rejected');
    expect(verdict.checks.map((check) => check.status)).toEqual(['verified', 'rejected']);
  });
});

describe('evidence pack', () => {
  async function writeSamples(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-pack-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'obs.json');
    const payload = SENSOR.map((obs) => ({
      frameId: obs.frameId,
      vars: obs.vars,
      hex: obs.bytes.toString('hex'),
    }));
    await writeFile(file, JSON.stringify(payload), 'utf8');
    return file;
  }

  it('bounds frames, reports omission and lists real verifiers', async () => {
    const file = await writeSamples();
    const { pack, evidence } = await buildEvidencePack({ path: file, maxFrames: 3 });

    expect(pack.schemaVersion).toBe(1);
    expect(pack.frames).toHaveLength(3);
    expect(pack.framesOmitted).toBe(2);
    expect(pack.verifiers.map((verifier) => verifier.name)).toEqual(['type_fit', 'checksum_coverage']);
    expect(pack.notes.join(' ')).toContain('not the whole capture');
    expect(evidence.source.sha256).toHaveLength(64);
  });

  it('loads hypothesis files in both supported shapes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-hyp-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'hyp.json');
    const hypothesis = {
      id: 'h1',
      kind: 'field_semantics',
      claim: 'offset 4 is f32le',
      checks: [{ verifier: 'type_fit', args: { offset: 4, width: 4, type: 'f32', endian: 'le', variable: 'temperature' } }],
    };

    await writeFile(file, JSON.stringify([hypothesis]), 'utf8');
    expect(await loadHypothesisFile(file)).toHaveLength(1);

    await writeFile(file, JSON.stringify({ hypotheses: [hypothesis] }), 'utf8');
    expect((await loadHypothesisFile(file))[0]?.id).toBe('h1');
  });

  it('verifies claims against the file end to end', async () => {
    const file = await writeSamples();
    const result = await verifyHypotheses({
      path: file,
      hypotheses: [
        claim([
          { verifier: 'type_fit', args: { offset: 4, width: 4, type: 'f32', endian: 'le', variable: 'temperature' } },
        ]),
      ],
    });

    expect(result.summary).toEqual({ verified: 1, rejected: 0, unverified: 0 });
    expect(result.evidence.source.sha256).toHaveLength(64);
  });
});
