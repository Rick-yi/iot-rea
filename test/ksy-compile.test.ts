import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyHypotheses } from '../src/app/verifyHypotheses.js';
import type { Hypothesis } from '../src/contracts/hypotheses.js';
import { sensorObservations } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const configured = process.env.IOT_REA_KAITAI;
const hasCompiler = (() => {
  if (configured !== undefined && configured !== '') return existsSync(configured);
  const entries = (process.env.PATH ?? '').split(path.delimiter);
  const names = process.platform === 'win32'
    ? ['kaitai-struct-compiler.bat', 'kaitai-struct-compiler.exe', 'kaitai-struct-compiler']
    : ['kaitai-struct-compiler'];
  return entries.some((entry) => path.isAbsolute(entry) && names.some((name) => existsSync(path.join(entry, name))));
})();

async function observationsFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-ksy-verify-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'obs.json');
  const payload = sensorObservations([21.5, 22.25, 23]).map((obs) => ({
    frameId: obs.frameId,
    vars: obs.vars,
    hex: obs.bytes.toString('hex'),
  }));
  await writeFile(file, JSON.stringify(payload), 'utf8');
  return file;
}

function hypothesis(args: Record<string, unknown>): Hypothesis {
  return {
    id: 'ksy',
    kind: 'codec',
    claim: 'the generated schema is accepted by the Kaitai compiler',
    evidenceRefs: [],
    checks: [{ verifier: 'ksy_compile', args }],
  };
}

const VALID_KSY = ['meta:', '  id: demo', 'seq:', '  - id: value', '    type: u1', ''].join('\n');

describe('ksy_compile', () => {
  it('treats missing schema arguments as unsupported', async () => {
    const file = await observationsFile();
    const result = await verifyHypotheses({ path: file, hypotheses: [hypothesis({})] });

    expect(result.verdicts[0]?.status).toBe('unverified');
    expect(result.verdicts[0]?.checks[0]?.detail).toContain('provide ksy text');
  });

  it('is unverified when the compiler is not configured', async () => {
    const file = await observationsFile();
    const previous = process.env.IOT_REA_KAITAI;
    delete process.env.IOT_REA_KAITAI;
    try {
      const result = await verifyHypotheses({ path: file, hypotheses: [hypothesis({ ksy: VALID_KSY })] });
      expect(result.verdicts[0]?.status).toBe('unverified');
      expect(result.verdicts[0]?.checks[0]?.detail).toContain('IOT_REA_KAITAI');
    } finally {
      if (previous !== undefined) process.env.IOT_REA_KAITAI = previous;
    }
  });
});

describe.skipIf(!hasCompiler)('ksy_compile with a compiler', () => {
  it('verifies a valid schema and rejects an invalid one', async () => {
    const file = await observationsFile();
    const result = await verifyHypotheses({
      path: file,
      hypotheses: [
        hypothesis({ ksy: VALID_KSY }),
        hypothesis({ ksy: 'meta:\n  id: broken\nseq:\n  - id: x\n    type: nope\n' }),
      ],
    });

    expect(result.verdicts.map((verdict) => verdict.status)).toEqual(['verified', 'rejected']);
    expect(result.verdicts[0]?.checks[0]?.detail).toContain('not executed');
    expect(result.verdicts[1]?.checks[0]?.detail).toContain('rejected the schema');
  });
});
