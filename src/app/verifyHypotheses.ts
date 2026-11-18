/**
 * verify-hypotheses: settle externally proposed claims with deterministic
 * checks. Nothing here calls a model or trusts a claim's prose.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Evidence } from '../contracts/evidence.js';
import { IotReaError } from '../contracts/errors.js';
import type { Hypothesis, HypothesisVerdict, HypothesisFile } from '../contracts/hypotheses.js';
import { hypothesisFileSchema, hypothesisSchema } from '../contracts/hypotheses.js';
import { runCheck, verdictFromChecks } from '../domain/verify.js';
import type { CheckResult } from '../contracts/hypotheses.js';
import { checkKsyCompile } from './verifiers/ksyCompile.js';
import { loadObservations } from './diffFrames.js';

export const verifyHypothesesInputSchema = z.object({
  path: z.string().min(1),
  hypotheses: z.array(hypothesisSchema).min(1),
});

export type VerifyHypothesesInput = z.infer<typeof verifyHypothesesInputSchema>;

export interface VerifyHypothesesResult {
  verdicts: HypothesisVerdict[];
  summary: { verified: number; rejected: number; unverified: number };
  evidence: Evidence;
}

export async function loadHypothesisFile(pathname: string): Promise<Hypothesis[]> {
  let text: string;
  try {
    text = await readFile(pathname, 'utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `cannot read hypotheses at ${pathname}: ${message}`, {
      path: pathname,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `hypotheses are not valid JSON: ${message}`, { path: pathname });
  }

  const parsed: HypothesisFile = hypothesisFileSchema.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.hypotheses;
}

export async function verifyHypotheses(input: VerifyHypothesesInput): Promise<VerifyHypothesesResult> {
  const parsed = verifyHypothesesInputSchema.parse(input);
  const loaded = await loadObservations(parsed.path);
  const verdicts = await Promise.all(
    parsed.hypotheses.map(async (hypothesis) => {
      const checks: CheckResult[] = await Promise.all(
        hypothesis.checks.map((check) =>
          check.verifier === 'ksy_compile'
            ? checkKsyCompile(check.args)
            : Promise.resolve(runCheck(check, loaded.observations)),
        ),
      );
      return verdictFromChecks(hypothesis.id, hypothesis.claim, checks);
    }),
  );

  const summary = { verified: 0, rejected: 0, unverified: 0 };
  for (const verdict of verdicts) summary[verdict.status] += 1;

  return {
    verdicts,
    summary,
    evidence: {
      source: { path: parsed.path, sha256: loaded.digest, size: loaded.size },
      limitations: [
        'verdicts describe only the supplied samples; verified is not proof about the device',
        'unsupported or invalid checks yield unverified, never a pass',
        'claims are supplied by the caller; this run does not establish who authored them',
      ],
    },
  };
}
