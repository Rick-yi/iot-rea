#!/usr/bin/env node
/**
 * CLI adapter. It translates arguments and formats output; it contains no
 * analysis logic, so a future MCP adapter can bind the same workflows.
 */
import { buildEvidencePack } from './app/advise.js';
import { bleFrames } from './app/bleFrames.js';
import { buildObservations } from './app/buildObservations.js';
import { doctor } from './app/doctor.js';
import { diffFrames } from './app/diffFrames.js';
import { exportKsy } from './app/exportKsy.js';
import { exportTelemetry } from './app/exportTelemetry.js';
import { inspectCapture } from './app/inspectCapture.js';
import { inferTransitions } from './app/inferTransitions.js';
import { inspectFirmware } from './app/inspectFirmware.js';
import { loadHypothesisFile, verifyHypotheses } from './app/verifyHypotheses.js';
import { IotReaError } from './contracts/errors.js';
import { decodeSignalRecording } from './providers/sigrok.js';
import { readSerialLog } from './providers/serial.js';

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
      const key = rawKey ?? '';
      if (inlineValue !== undefined) {
        flags.set(key, inlineValue);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        index += 1;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    positional.push(arg);
  }

  return { command: positional.shift() ?? 'help', positional, flags };
}

function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function has(args: Args, name: string): boolean {
  return args.flags.has(name);
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts;
}

function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function limit(args: Args): number | null | undefined {
  const value = flag(args, 'limit');
  if (value === undefined) return undefined;
  return value === 'all' ? null : number(value);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const json = has(args, 'json');
  const target = args.positional[0];

  switch (args.command) {
    case 'doctor': {
      const report = await doctor();
      if (json) printJson(report);
      else {
        console.log(`node ${report.node.version} (${report.node.supported ? 'supported' : 'unsupported'})`);
        for (const tool of report.tools) {
          console.log(
            `${tool.available ? 'ok  ' : 'miss'} ${tool.name}${tool.versionBanner === null ? '' : ` - ${tool.versionBanner}`}`,
          );
          if (!tool.available && tool.reason !== null) console.log(`     ${tool.reason}`);
        }
        for (const limitation of report.limitations) console.log(`limit ${limitation}`);
      }
      return 0;
    }

    case 'inspect-capture': {
      requireTarget(target, 'inspect-capture');
      const result = await inspectCapture({
        path: target,
        fields: list(flag(args, 'fields')),
        displayFilter: flag(args, 'filter'),
        decodeAs: list(flag(args, 'decode-as')),
        packetLimit: number(flag(args, 'packet-limit')),
        matchOffset: number(flag(args, 'offset')),
        matchLimit: limit(args),
        twoPass: has(args, 'two-pass'),
      });
      if (json) printJson(result);
      else {
        console.log(
          `rows ${result.window.returned}/${result.window.total} (offset ${result.window.offset}, hasMore ${result.window.hasMore})`,
        );
        for (const row of result.rows) {
          console.log(`#${row.frameNumber} ${JSON.stringify(row.fields)}`);
        }
        printLimitations(result.evidence.limitations);
      }
      return 0;
    }

    case 'build-observations': {
      requireTarget(target, 'build-observations');
      const result = await buildObservations({
        path: target,
        payloadField: flag(args, 'payload-field'),
        labelsPath: flag(args, 'labels'),
        labelsFormat: flag(args, 'labels-format') as 'auto' | 'csv' | 'json' | undefined,
        displayFilter: flag(args, 'filter'),
        decodeAs: list(flag(args, 'decode-as')),
        packetLimit: number(flag(args, 'packet-limit')),
      });

      const outPath = flag(args, 'out');
      if (outPath === undefined || outPath === '-') {
        printJson(result);
        return 0;
      }

      const { writeFile } = await import('node:fs/promises');
      await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      if (json) {
        printJson({ ...result, out: outPath });
      } else {
        console.log(
          `wrote ${outPath}: ${result.observations.length} observation(s), ` +
            `${result.stats.unlabelled} unlabelled, ${result.stats.skippedNoPayload} without payload`,
        );
        printLimitations(result.unknowns);
      }
      return 0;
    }

    case 'ble-frames': {
      requireTarget(target, 'ble-frames');
      const result = await bleFrames({
        path: target,
        peerAddress: flag(args, 'peer'),
        displayFilter: flag(args, 'filter'),
        packetLimit: number(flag(args, 'packet-limit')),
        labelsPath: flag(args, 'labels'),
        labelsFormat: flag(args, 'labels-format') as 'auto' | 'csv' | 'json' | undefined,
      });

      const outPath = flag(args, 'out');
      if (outPath === undefined || outPath === '-') {
        printJson(result);
        return 0;
      }

      const { writeFile } = await import('node:fs/promises');
      await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      if (json) {
        printJson({ ...result, out: outPath });
      } else {
        console.log(
          `wrote ${outPath}: ${result.frames.length} frame(s), ` +
            `${result.observations?.length ?? 0} observation(s), ${result.stats.unknownDirection} unknown direction`,
        );
        printLimitations(result.unknowns);
      }
      return 0;
    }

    case 'inspect-firmware': {
      requireTarget(target, 'inspect-firmware');
      const result = await inspectFirmware({
        path: target,
        extractTo: flag(args, 'extract'),
      });
      if (json) printJson(result);
      else {
        const inv = result.inventory;
        console.log(`format ${inv.format} size ${inv.size}`);
        for (const region of inv.regions) {
          console.log(`region ${region.path} (${region.length} bytes)`);
        }
        for (const [key, value] of Object.entries(inv.metadata)) {
          console.log(`${key} ${JSON.stringify(value)}`);
        }
        for (const extracted of result.extracted) {
          console.log(`wrote ${extracted.path} (${extracted.bytes} bytes)`);
        }
        printLimitations(inv.unknowns);
      }
      return 0;
    }

    case 'diff-frames': {
      requireTarget(target, 'diff-frames');
      const result = await diffFrames({
        path: target,
        minSamples: number(flag(args, 'min-samples')),
        matchLimit: limit(args),
      });

      const ksyTarget = flag(args, 'ksy');
      let ksyInfo: { path: string | null; id: string; bytes: number } | undefined;
      if (ksyTarget !== undefined) {
        const rendered = await exportKsy(result, ksyTarget, { id: flag(args, 'id') });
        ksyInfo = { path: rendered.path, id: rendered.id, bytes: Buffer.byteLength(rendered.text) };
        if (rendered.path === null) {
          // `--ksy -` prints only the draft so stdout stays pipeable.
          process.stdout.write(rendered.text);
          return 0;
        }
      }

      if (json) printJson(ksyInfo === undefined ? result : { ...result, ksy: ksyInfo });
      else {
        console.log(`samples ${result.sampleCount}, aligned length ${result.differential.alignedLength}`);
        const alignment = result.differential.alignment;
        if (alignment !== undefined) {
          console.log(
            `alignment payload @0x${alignment.payloadStart.toString(16)} (${alignment.payloadLength} bytes; ` +
              `length field @0x${alignment.fieldOffset.toString(16)})`,
          );
        }
        for (const region of result.differential.regions) {
          console.log(`variable 0x${region.offset.toString(16)}..0x${region.end.toString(16)} (${region.width} bytes)`);
        }
        for (const field of result.fields) {
          const endian = field.endian === null ? '' : ` ${field.endian}`;
          console.log(
            `field ${field.variable}: ${field.type}${endian} @0x${field.offset.toString(16)} width ${field.width} confidence ${field.confidence.toFixed(2)}`,
          );
        }
        for (const derived of result.derived) {
          const endian = derived.endian === null ? '' : ` ${derived.endian}`;
          console.log(
            `derived ${derived.relation}: ${derived.type}${endian} @0x${derived.offset.toString(16)} ` +
              `(${derived.matched}/${derived.total} matched)`,
          );
        }
        for (const checksum of result.checksums) {
          console.log(
            `checksum ${checksum.algorithm} @0x${checksum.position.toString(16)} ${checksum.endian} confidence ${checksum.confidence.toFixed(2)}`,
          );
        }
        if (ksyInfo !== undefined && ksyInfo.path !== null) {
          console.log(`wrote ksy ${ksyInfo.path} (${ksyInfo.bytes} bytes, id ${ksyInfo.id})`);
        }
        printLimitations(result.unknowns);
      }
      return 0;
    }

    case 'export-telemetry': {
      requireTarget(target, 'export-telemetry');
      const deviceId = flag(args, 'device-id');
      const outDir = flag(args, 'out');
      if (deviceId === undefined) throw new IotReaError('invalid_request', '--device-id <id> is required');
      if (outDir === undefined) throw new IotReaError('invalid_request', '--out <dir> is required');

      const result = await exportTelemetry({
        path: target,
        deviceId,
        outDir,
        minConfidence: number(flag(args, 'min-confidence')),
        tsBase: number(flag(args, 'ts-base')),
        tsStep: number(flag(args, 'ts-step')),
        schemaVersion: flag(args, 'schema-version'),
      });

      if (json) {
        printJson(result);
        return 0;
      }
      console.log(`mapping  ${result.mappingPath} (${result.mapping.fields.length} field(s))`);
      console.log(`telemetry ${result.telemetryPath} (${result.records.length} record(s))`);
      for (const record of result.records.slice(0, 3)) {
        console.log(`  ${record.frameId} ts=${record.ts} quality=${record.quality} ${JSON.stringify(record.values)}`);
      }
      printLimitations(result.evidence.limitations);
      return 0;
    }

    case 'infer-transitions': {
      requireTarget(target, 'infer-transitions');
      const result = await inferTransitions({
        path: target,
        signatureBytes: number(flag(args, 'signature-bytes')),
        channel: flag(args, 'channel'),
      });

      const mermaidTarget = flag(args, 'mermaid');
      if (mermaidTarget === '-') {
        process.stdout.write(result.mermaid);
        return 0;
      }
      if (mermaidTarget !== undefined) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(mermaidTarget, result.mermaid, 'utf8');
      }

      if (json) {
        printJson(mermaidTarget === undefined ? result : { ...result, mermaidPath: mermaidTarget });
        return 0;
      }

      console.log(
        `frames ${result.stats.frames}, channels ${result.stats.channels}, ` +
          `nodes ${result.nodes.length}, edges ${result.stats.edges} (${result.stats.singleObservationEdges} single)`,
      );
      for (const edge of result.edges) {
        console.log(`${edge.from} -> ${edge.to} x${edge.count}`);
      }
      if (mermaidTarget !== undefined) console.log(`wrote mermaid ${mermaidTarget}`);
      printLimitations(result.unknowns);
      return 0;
    }

    case 'evidence-pack': {
      requireTarget(target, 'evidence-pack');
      const result = await buildEvidencePack({
        path: target,
        maxFrames: number(flag(args, 'max-frames')),
      });

      const outPath = flag(args, 'out');
      if (outPath === undefined || outPath === '-') {
        printJson(result.pack);
        return 0;
      }

      const { writeFile } = await import('node:fs/promises');
      await writeFile(outPath, `${JSON.stringify(result.pack, null, 2)}\n`, 'utf8');
      if (json) {
        printJson({ ...result, out: outPath });
      } else {
        console.log(
          `wrote ${outPath}: ${result.pack.samples.count} sample(s), ${result.pack.fields.length} field(s), ` +
            `${result.pack.frames.length} frame(s) (${result.pack.framesOmitted} omitted)`,
        );
        printLimitations(result.evidence.limitations);
      }
      return 0;
    }

    case 'verify-hypotheses': {
      requireTarget(target, 'verify-hypotheses');
      const hypothesesPath = flag(args, 'hypotheses');
      if (hypothesesPath === undefined) {
        throw new IotReaError('invalid_request', '--hypotheses <file> is required');
      }
      const hypotheses = await loadHypothesisFile(hypothesesPath);
      const result = await verifyHypotheses({ path: target, hypotheses });

      if (json) {
        printJson(result);
        return 0;
      }

      console.log(
        `verified ${result.summary.verified}, rejected ${result.summary.rejected}, ` +
          `unverified ${result.summary.unverified}`,
      );
      for (const verdict of result.verdicts) {
        console.log(`${verdict.status.padEnd(10)} ${verdict.id}: ${verdict.claim}`);
        for (const check of verdict.checks) {
          const suffix =
            check.status === 'unsupported'
              ? ` (${check.detail ?? 'unsupported'})`
              : ` (${check.matched}/${check.total}${check.counterexamples.length > 0 ? `, counterexamples: ${check.counterexamples.join(', ')}` : ''})`;
          console.log(`  ${check.status.padEnd(10)} ${check.verifier}${suffix}`);
        }
      }
      printLimitations(result.evidence.limitations);
      return 0;
    }

    case 'decode-signals': {
      requireTarget(target, 'decode-signals');
      const decoders = list(flag(args, 'decoders'));
      if (decoders === undefined) throw new IotReaError('invalid_request', '--decoders is required, e.g. uart:rx=RX:baudrate=9600');
      const result = await decodeSignalRecording({
        path: target,
        decoders,
        inputFormat: flag(args, 'input-format'),
        annotations: list(flag(args, 'annotations')),
        lineOffset: number(flag(args, 'offset')),
        lineLimit: limit(args),
      });
      if (json) printJson(result);
      else {
        console.log(`lines ${result.window.returned}/${result.window.total} (hasMore ${result.window.hasMore})`);
        for (const line of result.lines) console.log(line);
      }
      return 0;
    }

    case 'mcp': {
      // stdout belongs to the protocol; the server logs to stderr only.
      const { startMcpServer } = await import('./mcp/server.js');
      await startMcpServer();
      return 0;
    }

    case 'read-serial': {
      requireTarget(target, 'read-serial');
      const result = await readSerialLog(target);
      if (json) printJson(result);
      else {
        console.log(`frames ${result.frames.length}, skipped lines ${result.skippedLines}`);
        for (const row of result.rows.slice(0, 20)) {
          console.log(`#${row.index} ${row.direction} ${row.hex}`);
        }
        if (result.rows.length > 20) console.log(`... ${result.rows.length - 20} more`);
        printLimitations(result.evidence.limitations);
      }
      return 0;
    }

    case 'help':
    default:
      printHelp();
      return args.command === 'help' ? 0 : 1;
  }
}

function requireTarget(target: string | undefined, command: string): asserts target is string {
  if (target === undefined) {
    throw new IotReaError('invalid_request', `${command} requires a file path`);
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printLimitations(limitations: string[] | undefined): void {
  for (const limitation of limitations ?? []) console.log(`limit ${limitation}`);
}

function printHelp(): void {
  console.log(`iot-rea - evidence-first reverse engineering for IoT captures

usage:
  iot-rea doctor [--json]
  iot-rea inspect-capture <capture> [--fields a,b] [--filter expr]
                        [--decode-as rule] [--packet-limit n]
                        [--offset n] [--limit n|all] [--two-pass] [--json]
  iot-rea build-observations <capture> [--payload-field data.data]
                        [--labels <csv|json>] [--labels-format auto|csv|json]
                        [--filter expr] [--decode-as rule] [--packet-limit n]
                        [--out <obs.json>|--out -] [--json]
  iot-rea ble-frames <capture> [--peer <bd_addr>] [--labels <csv|json>]
                        [--filter expr] [--packet-limit n]
                        [--out <obs.json>|--out -] [--json]
  iot-rea inspect-firmware <artifact> [--extract <dir>] [--json]
  iot-rea diff-frames <observations.json> [--min-samples n]
                        [--ksy <out.ksy>|--ksy -] [--id name] [--json]
  iot-rea export-telemetry <observations.json> --device-id <id> --out <dir>
                        [--min-confidence n] [--ts-base ms] [--ts-step ms]
                        [--schema-version s] [--json]
  iot-rea infer-transitions <frames.json> [--signature-bytes n]
                        [--channel name] [--mermaid <out.md>|--mermaid -] [--json]
  iot-rea evidence-pack <observations.json> [--max-frames n]
                        [--out <pack.json>|--out -] [--json]
  iot-rea verify-hypotheses <observations.json> --hypotheses <file> [--json]
  iot-rea decode-signals <recording> --decoders uart:rx=RX:baudrate=9600
                        [--input-format vcd] [--annotations a=b] [--json]
  iot-rea read-serial <log> [--json]
  iot-rea mcp                     # MCP server over stdio

environment:
  IOT_REA_TSHARK   absolute path to tshark
  IOT_REA_SIGROK   absolute path to sigrok-cli

boundaries:
  reads recorded data only; does not open interfaces or control devices
  external tools are caller-supplied and never installed`);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (cause: unknown) => {
    if (cause instanceof IotReaError) {
      console.error(`error[${cause.code}] ${cause.message}`);
      if (Object.keys(cause.details).length > 0) {
        console.error(JSON.stringify(cause.details, null, 2));
      }
    } else {
      console.error(`error ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    process.exitCode = 1;
  },
);
