/**
 * Bounded execution primitives shared by every provider.
 *
 * Invariants (borrowed from REA's adapter rules):
 *  - configured executables must be absolute paths; relative lookups are refused
 *  - the source file is never handed to a tool; a private copy is used
 *  - input bytes, wall clock and combined stdout+stderr are bounded
 *  - exceeding an output bound fails; it never returns truncated success
 *  - the executable and the private copy are hashed before and after the run
 *  - an empty result is a windowed observation, never proof of absence
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IotReaError } from '../contracts/errors.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_INPUT_BYTES = 32 * 1024 * 1024;

export interface RunOptions {
  command: string;
  args: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdin?: string;
}

export interface RunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Run a child process with a hard wall clock and a hard combined output budget.
 * Throws on overflow and timeout. Non-zero exits are reported, not thrown,
 * because some producers emit usable output with warnings on stderr.
 */
export function runLimited(options: RunOptions): Promise<RunOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  // Windows batch files cannot be spawned directly (EINVAL); route them
  // through cmd.exe with verbatim arguments, quoting every token.
  const isBatch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(options.command);
  const command = isBatch ? process.env.ComSpec ?? 'cmd.exe' : options.command;
  const quoted = options.args.map((arg) => `"${arg}"`).join(' ');
  // cmd /s /c needs one outer quote pair around a quoted first token. Build it
  // explicitly: ""command" "arg"" (two opening, two closing quotes).
  const args = isBatch
    ? ['/d', '/s', '/c', `""${options.command}"${quoted === '' ? '' : ` ${quoted}`}"`]
    : [...options.args];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      windowsVerbatimArguments: isBatch,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let overflow = false;
    let timedOut = false;

    const settleOverflow = (): void => {
      overflow = true;
      child.kill('SIGKILL');
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) {
        settleOverflow();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) {
        settleOverflow();
        return;
      }
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (cause) => {
      clearTimeout(timer);
      reject(
        new IotReaError('missing_tool', `cannot execute ${options.command}: ${cause.message}`, {
          command: options.command,
          cause: cause.message,
        }),
      );
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (overflow) {
        reject(
          new IotReaError('output_limit', `producer output exceeded ${maxOutputBytes} bytes`, {
            limitBytes: maxOutputBytes,
            command: options.command,
            stdout,
            stderr,
          }),
        );
        return;
      }
      if (timedOut) {
        reject(
          new IotReaError('timeout', `producer exceeded ${timeoutMs} ms`, {
            timeoutMs,
            command: options.command,
            stdout,
            stderr,
          }),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode, signal });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

export interface ResolvedTool {
  configuredPath: string | null;
  resolvedPath: string;
}

function isExecutableName(name: string): boolean {
  if (process.platform === 'win32') {
    const ext = path.extname(name).toLowerCase();
    const pathext = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';');
    return pathext.includes(ext);
  }
  return true;
}

export async function isFile(pathname: string): Promise<boolean> {
  try {
    const info = await stat(pathname);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a tool from an env override or the first absolute PATH entry that
 * holds it. Relative PATH entries and relative overrides are refused.
 */
export async function resolveExecutable(
  tool: string,
  configured: string | undefined,
): Promise<ResolvedTool> {
  if (configured !== undefined && configured !== '') {
    if (!path.isAbsolute(configured)) {
      throw new IotReaError(
        'invalid_request',
        `${tool} override must be an absolute path, got "${configured}"`,
        { tool, configured },
      );
    }
    if (!(await isFile(configured))) {
      throw new IotReaError('missing_tool', `${tool} not found at ${configured}`, {
        tool,
        configured,
      });
    }
    return { configuredPath: configured, resolvedPath: configured };
  }

  const entries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry !== '' && path.isAbsolute(entry));
  const candidates = process.platform === 'win32'
    ? [tool, `${tool}.exe`, `${tool}.cmd`, `${tool}.bat`]
    : [tool];

  for (const dir of entries) {
    for (const candidate of candidates) {
      if (!isExecutableName(candidate)) continue;
      const full = path.join(dir, candidate);
      try {
        await access(full, fsConstants.X_OK);
        if (await isFile(full)) return { configuredPath: null, resolvedPath: full };
      } catch {
        // keep looking
      }
    }
  }

  throw new IotReaError('missing_tool', `${tool} was not found on PATH`, { tool });
}

export async function sha256File(pathname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(pathname);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function fileSize(pathname: string): Promise<number> {
  try {
    return (await stat(pathname)).size;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `cannot stat ${pathname}: ${message}`, {
      path: pathname,
    });
  }
}

export async function probeVersion(
  resolvedPath: string,
  versionArgs: readonly string[] = ['--version'],
): Promise<string | null> {
  try {
    const outcome = await runLimited({
      command: resolvedPath,
      args: versionArgs,
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    const banner = `${outcome.stdout}${outcome.stderr}`.trim().split(/\r?\n/)[0] ?? '';
    return banner === '' ? null : banner;
  } catch {
    return null;
  }
}

/**
 * Copy the source into a private directory so a producer never sees the
 * caller's path, and so format detection by filename still works.
 */
export async function privateCopy(sourcePath: string): Promise<{
  path: string;
  digest: string;
  size: number;
  cleanup: () => Promise<void>;
}> {
  const digest = await sha256File(sourcePath);
  const size = await fileSize(sourcePath);
  if (size > DEFAULT_MAX_INPUT_BYTES) {
    throw new IotReaError('input_limit', `input is ${size} bytes, limit is ${DEFAULT_MAX_INPUT_BYTES}`, {
      size,
      limitBytes: DEFAULT_MAX_INPUT_BYTES,
    });
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'iot-rea-'));
  const copyPath = path.join(dir, path.basename(sourcePath));
  await copyFile(sourcePath, copyPath);
  try {
    await chmod(copyPath, 0o444);
  } catch {
    // read-only chmod is advisory on Windows; the private copy is still isolated
  }

  return {
    path: copyPath,
    digest,
    size,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function verifyDigest(
  pathname: string,
  expected: string,
  role: string,
): Promise<void> {
  const actual = await sha256File(pathname);
  if (actual !== expected) {
    throw new IotReaError('integrity_failure', `${role} changed during the run`, {
      role,
      expected,
      actual,
    });
  }
}
