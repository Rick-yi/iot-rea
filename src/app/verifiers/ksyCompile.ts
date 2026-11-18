/**
 * ksy_compile verifier: ask the caller-supplied Kaitai compiler to accept a
 * schema. The generated parser is never executed; this is a schema-validity
 * check, not a parser-correctness check.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IotReaError } from '../../contracts/errors.js';
import type { CheckResult } from '../../contracts/hypotheses.js';
import { ksyCompileArgsSchema } from '../../contracts/hypotheses.js';
import { resolveExecutable, probeVersion, runLimited, sha256File } from '../../providers/process.js';

const MAX_KSY_BYTES = 256 * 1024;
const TARGET_EXTENSION: Record<string, string> = {
  javascript: '.js',
  python: '.py',
  java: '.java',
};

export async function checkKsyCompile(rawArgs: unknown): Promise<CheckResult> {
  const parsed = ksyCompileArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return unsupported(`invalid ksy_compile args: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  }
  const args = parsed.data;
  const target = args.target ?? 'javascript';

  let ksy: string;
  try {
    ksy = args.ksy ?? (await readFile(args.path as string, 'utf8'));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return unsupported(`cannot read schema: ${message}`);
  }
  if (Buffer.byteLength(ksy, 'utf8') > MAX_KSY_BYTES) {
    return unsupported(`schema exceeds ${MAX_KSY_BYTES} bytes`);
  }

  let tool: { configuredPath: string | null; resolvedPath: string };
  try {
    tool = await resolveExecutable('kaitai-struct-compiler', process.env.IOT_REA_KAITAI);
  } catch (cause) {
    const message = cause instanceof IotReaError ? cause.message : String(cause);
    return unsupported(`${message}; set IOT_REA_KAITAI to an absolute compiler path`);
  }
  const version = await probeVersion(tool.resolvedPath, ['--version']);
  const toolDigest = await sha256File(tool.resolvedPath);

  const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-ksy-'));
  const schemaPath = path.join(dir, 'schema.ksy');
  const outDir = path.join(dir, 'out');
  try {
    await writeFile(schemaPath, ksy, 'utf8');
    await mkdir(outDir, { recursive: true });

    const outcome = await runLimited({
      command: tool.resolvedPath,
      args: ['--target', target, '--outdir', outDir, schemaPath],
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });

    if (outcome.exitCode !== 0) {
      const excerpt = `${outcome.stderr}${outcome.stdout}`.trim().split(/\r?\n/)[0] ?? 'compiler failed';
      return rejected(`compiler rejected the schema: ${excerpt}`);
    }

    const outputs = await readdir(outDir).catch(() => [] as string[]);
    const extension = TARGET_EXTENSION[target] ?? '';
    const produced = outputs.filter((file) => file.endsWith(extension));
    if (produced.length === 0) {
      return rejected(`compiler exited 0 but produced no ${target} output`);
    }

    return {
      verifier: 'ksy_compile',
      status: 'verified',
      matched: 1,
      total: 1,
      counterexamples: [],
      detail:
        `compiled with kaitai-struct-compiler ${version ?? '(unknown version)'} (${toolDigest.slice(0, 12)}); ` +
        'generated parser was not executed',
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function unsupported(detail: string): CheckResult {
  return { verifier: 'ksy_compile', status: 'unsupported', matched: 0, total: 0, counterexamples: [], detail };
}

function rejected(detail: string): CheckResult {
  return { verifier: 'ksy_compile', status: 'rejected', matched: 0, total: 1, counterexamples: [], detail };
}
