/**
 * sigrok-cli adapter for recorded logic signals.
 *
 * REA does not parse decoder display text into protocol facts; this provider
 * keeps the same rule: lines are returned verbatim with their sample ranges.
 */
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

export interface SigrokRequest {
  path: string;
  decoders: string[];
  inputFormat?: string;
  annotations?: string[];
  lineOffset?: number;
  lineLimit?: number | null;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SigrokPage {
  lines: string[];
  window: OutputWindow;
  evidence: Evidence;
}

export function buildSigrokArgs(request: SigrokRequest, recordingPath: string): string[] {
  const args = ['-i', recordingPath];
  if (request.inputFormat !== undefined && request.inputFormat !== '') {
    args.push('--input-format', request.inputFormat);
  }
  // sigrok-cli names these --protocol-decoders / --protocol-decoder-annotations;
  // --decoders does not exist and exits with "Unknown option".
  if (request.decoders.length > 0) args.push('--protocol-decoders', request.decoders.join(','));
  if (request.annotations !== undefined && request.annotations.length > 0) {
    args.push('--protocol-decoder-annotations', request.annotations.join(','));
  }
  return args;
}

export async function decodeSignalRecording(request: SigrokRequest): Promise<SigrokPage> {
  if (request.decoders.length === 0) {
    throw new IotReaError('invalid_request', 'at least one decoder is required, e.g. uart:rx=RX');
  }
  if (!/^[A-Za-z0-9_:,=.-]+$/.test(request.decoders.join(','))) {
    throw new IotReaError('invalid_request', 'decoder selector contains unsupported characters');
  }

  const { configuredPath, resolvedPath } = await resolveExecutable(
    'sigrok-cli',
    process.env.IOT_REA_SIGROK,
  );
  const versionBanner = await probeVersion(resolvedPath);
  const executableDigest = await sha256File(resolvedPath);

  const copy = await privateCopy(request.path);
  const args = buildSigrokArgs(request, copy.path);
  try {
    // sigrok derives format from the filename suffix; the private copy keeps it.
    if (!/\.(sr|vcd|csv|srzip)$/i.test(copy.path)) {
      throw new IotReaError('unsupported_input', 'recording suffix must be one of .sr, .vcd, .csv, .srzip', {
        path: request.path,
      });
    }

    const outcome = await runLimited({
      command: resolvedPath,
      args,
      timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    });

    if (outcome.exitCode !== 0) {
      const excerpt = outcome.stderr.trim().split(/\r?\n/)[0] ?? '';
      throw new IotReaError(
        'invalid_request',
        `sigrok-cli exited with ${outcome.exitCode ?? 'signal'}${excerpt === '' ? '' : `: ${excerpt}`}`,
        { exitCode: outcome.exitCode, stderr: outcome.stderr },
      );
    }

    const lines = outcome.stdout.split(/\r?\n/).filter((line) => line !== '');
    const offset = request.lineOffset ?? 0;
    const limit = request.lineLimit === undefined ? 50 : request.lineLimit;
    const windowed = limit === null ? lines.slice(offset) : lines.slice(offset, offset + limit);
    const window: OutputWindow = {
      offset,
      requestedLimit: limit,
      total: lines.length,
      returned: windowed.length,
      hasMore: offset + windowed.length < lines.length,
    };

    await verifyDigest(copy.path, copy.digest, 'private recording copy');
    await verifyDigest(resolvedPath, executableDigest, 'sigrok-cli executable');

    return {
      lines: windowed,
      window,
      evidence: {
        source: { path: request.path, sha256: copy.digest, size: copy.size },
        tool: { configuredPath, resolvedPath, versionBanner, sha256: executableDigest },
        argv: args,
        stderr: outcome.stderr,
        warnings: outcome.stderr.trim() === '' ? undefined : [outcome.stderr.trim()],
        window,
        limitations: [
          'decoder text is producer output, not an independently verified protocol fact',
          'REA does not guess wiring, channel names or baud rate; wrong selections yield wrong text',
        ],
      },
    };
  } finally {
    await copy.cleanup();
  }
}
