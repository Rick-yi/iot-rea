/**
 * Transport-neutral MCP tool definitions.
 *
 * Keeping the handlers free of SDK imports lets unit tests exercise schemas and
 * error mapping without a live connection; src/mcp/server.ts only binds these
 * definitions to the protocol.
 */
import { z } from 'zod';
import { buildEvidencePack } from '../app/advise.js';
import { bleFrames } from '../app/bleFrames.js';
import { buildObservations } from '../app/buildObservations.js';
import { doctor } from '../app/doctor.js';
import { diffFrames } from '../app/diffFrames.js';
import { renderKaitai } from '../app/exportKsy.js';
import { verifyHypotheses } from '../app/verifyHypotheses.js';
import { hypothesisSchema } from '../contracts/hypotheses.js';
import { inspectCapture } from '../app/inspectCapture.js';
import { inspectFirmware } from '../app/inspectFirmware.js';
import { IotReaError } from '../contracts/errors.js';
import { decodeSignalRecording } from '../providers/sigrok.js';
import { readSerialLog } from '../providers/serial.js';

export interface ToolOutput {
  // Index signature matches the MCP SDK's CallToolResult shape.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  /** False for tools that can write to the caller's filesystem. */
  readOnly: boolean;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  run: (input: unknown) => Promise<ToolOutput>;
}

function success(value: object): ToolOutput {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function failure(error: unknown): ToolOutput {
  const payload =
    error instanceof IotReaError
      ? error.toJSON()
      : { code: 'internal_error', message: error instanceof Error ? error.message : String(error) };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function define<S extends z.ZodRawShape, O extends object>(
  name: string,
  title: string,
  description: string,
  shape: S,
  handler: (input: z.infer<z.ZodObject<S>>) => Promise<O>,
  options: { readOnly?: boolean } = {},
): McpTool {
  const inputSchema = z.object(shape);
  return {
    name,
    title,
    description,
    readOnly: options.readOnly ?? true,
    inputSchema,
    run: async (input: unknown) => {
      try {
        const parsed = inputSchema.parse(input);
        return success(await handler(parsed));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const pathField = z.string().min(1).describe('Absolute or workspace-relative path to the recorded file');

export const MCP_TOOLS: McpTool[] = [
  define(
    'doctor',
    'Check host readiness',
    'Report Node.js support and whether tshark / sigrok-cli are resolvable. Missing tools are limitations, not silent fallbacks.',
    {},
    async () => doctor(),
  ),

  define(
    'inspect_capture',
    'Inspect a packet capture',
    'Read selected fields from an existing pcap/pcapng (including BLE HCI/btsnoop) with a display filter. Does not open interfaces or capture live traffic. Returns rows, an output window, and Evidence with the source digest and tool version.',
    {
      path: pathField,
      fields: z
        .array(z.string().min(1))
        .max(1024)
        .optional()
        .describe('TShark field names, e.g. ["frame.number","udp.dstport","data.data"]'),
      display_filter: z.string().optional().describe('Wireshark display filter, e.g. "udp.port == 5683"'),
      decode_as: z
        .array(z.string().min(1))
        .max(1024)
        .optional()
        .describe('Dissector overrides, e.g. ["udp.port==5555,mqtt"]'),
      packet_limit: z.number().int().positive().optional().describe('Maximum input packets read before filtering'),
      match_offset: z.number().int().nonnegative().optional(),
      match_limit: z.number().int().positive().nullable().optional().describe('null returns all remaining matches'),
      two_pass: z.boolean().optional(),
    },
    async (input) =>
      inspectCapture({
        path: input.path,
        fields: input.fields,
        displayFilter: input.display_filter,
        decodeAs: input.decode_as,
        packetLimit: input.packet_limit,
        matchOffset: input.match_offset,
        matchLimit: input.match_limit,
        twoPass: input.two_pass,
      }),
  ),

  define(
    'diff_frames',
    'Differential field inference',
    'Compare labelled observations that vary one business value at a time. Returns variable regions, field type candidates with confidence and counterexamples, checksum candidates, and explicit unknowns.',
    {
      path: pathField.describe('JSON file: [{frameId, vars, hex}] or {"observations": [...]}'),
      min_samples: z.number().int().min(2).max(1000).optional().describe('Default 3'),
    },
    async (input) => diffFrames({ path: input.path, minSamples: input.min_samples }),
  ),

  define(
    'inspect_firmware',
    'Inspect a firmware artifact',
    'Static inventory of UF2, Intel HEX, S-record or DfuSe containers. No extraction tool, mount, emulation or execution is involved. Regions are address-contiguous and gaps are never filled.',
    {
      path: pathField,
      extract_to: z.string().min(1).optional().describe('Directory to materialize decoded regions into'),
    },
    async (input) => inspectFirmware({ path: input.path, extractTo: input.extract_to }),
    { readOnly: false },
  ),

  define(
    'decode_signals',
    'Decode a recorded logic signal',
    'Run sigrok-cli over an existing .sr/.vcd/.csv/.srzip recording and return decoder text verbatim with its sample ranges. Does not acquire samples or guess wiring.',
    {
      path: pathField,
      decoders: z
        .array(z.string().min(1))
        .min(1)
        .describe('sigrok decoder selectors, e.g. ["uart:rx=RX:baudrate=9600"]'),
      input_format: z.string().optional().describe('vcd, sr, csv or srzip; omitted means autodetect'),
      annotations: z.array(z.string().min(1)).optional().describe('Annotation selectors, e.g. ["uart=rx-data"]'),
      line_offset: z.number().int().nonnegative().optional(),
      line_limit: z.number().int().positive().nullable().optional(),
    },
    async (input) =>
      decodeSignalRecording({
        path: input.path,
        decoders: input.decoders,
        inputFormat: input.input_format,
        annotations: input.annotations,
        lineOffset: input.line_offset,
        lineLimit: input.line_limit,
      }),
  ),

  define(
    'read_serial',
    'Parse a recorded serial log',
    'Parse timestamped TX/RX hex lines or JSONL serial recordings into normalized frames. Lines that do not parse are counted as unknown, never dropped silently.',
    { path: pathField },
    async (input) => readSerialLog(input.path),
  ),

  define(
    'build_observations',
    'Build labelled observations from a capture',
    'Read a recorded pcap/BLE capture through TShark, attach labels by frame number, and return diff-compatible observations. Frames without payload and samples without labels are counted and reported, never dropped silently.',
    {
      path: pathField,
      payload_field: z.string().min(1).optional().describe('TShark payload field, default "data.data"'),
      labels_path: z.string().min(1).optional().describe('CSV or JSON label file matched by frame number'),
      labels_format: z.enum(['auto', 'csv', 'json']).optional(),
      display_filter: z.string().optional().describe('Wireshark display filter, e.g. "udp.port == 9999"'),
      decode_as: z.array(z.string().min(1)).max(1024).optional(),
      packet_limit: z.number().int().positive().optional(),
    },
    async (input) =>
      buildObservations({
        path: input.path,
        payloadField: input.payload_field,
        labelsPath: input.labels_path,
        labelsFormat: input.labels_format,
        displayFilter: input.display_filter,
        decodeAs: input.decode_as,
        packetLimit: input.packet_limit,
      }),
  ),

  define(
    'ble_frames',
    'Normalize BLE ATT frames',
    'Map recorded ATT traffic to att:0xhhhh channels with a direction. Direction comes from HCI addresses when peer_address is supplied, otherwise from ATT opcode semantics with the central-is-host assumption stated in limitations. Optional labels produce diff-compatible observations.',
    {
      path: pathField,
      peer_address: z.string().min(1).optional().describe('Device BD_ADDR, e.g. "AA:BB:CC:DD:EE:FF"'),
      display_filter: z.string().optional(),
      packet_limit: z.number().int().positive().optional(),
      labels_path: z.string().min(1).optional(),
      labels_format: z.enum(['auto', 'csv', 'json']).optional(),
    },
    async (input) =>
      bleFrames({
        path: input.path,
        peerAddress: input.peer_address,
        displayFilter: input.display_filter,
        packetLimit: input.packet_limit,
        labelsPath: input.labels_path,
        labelsFormat: input.labels_format,
      }),
  ),

  define(
    'evidence_pack',
    'Build an evidence pack for an external proposer',
    'Return a bounded, self-describing pack (samples, field candidates, variable regions, checksum candidates, unknowns, sample frames) plus the verifiers that can settle a claim. The core does not call a model; this is the seam an external proposer consumes.',
    {
      path: pathField.describe('JSON observations: [{frameId, vars, hex}] or {"observations": [...]}'),
      max_frames: z.number().int().min(1).max(200).optional().describe('Sample frames to include, default 20'),
    },
    async (input) => buildEvidencePack({ path: input.path, maxFrames: input.max_frames }),
  ),

  define(
    'verify_hypotheses',
    'Settle proposed hypotheses deterministically',
    'Recompute each proposed claim against the supplied samples. A claim is verified only when every usable sample passes; unsupported or invalid checks yield unverified, never a silent pass.',
    {
      path: pathField.describe('JSON observations the claims are checked against'),
      hypotheses: z
        .array(hypothesisSchema)
        .min(1)
        .describe('Claims with deterministic checks, e.g. type_fit or checksum_coverage'),
    },
    async (input) => verifyHypotheses({ path: input.path, hypotheses: input.hypotheses }),
  ),

  define(
    'export_ksy',
    'Draft a Kaitai Struct schema',
    'Run differential inference on labelled observations and return a draft .ksy document as text. Bytes without a hypothesis stay explicit reserved fields; weaker overlapping hypotheses are dropped and listed. This tool does not write files.',
    {
      path: pathField.describe('JSON observations: [{frameId, vars, hex}] or {"observations": [...]}'),
      id: z.string().min(1).optional().describe('Kaitai meta.id; sanitized to a safe identifier'),
    },
    async (input) => {
      const draft = await diffFrames({ path: input.path });
      const rendered = renderKaitai(draft, { id: input.id });
      return {
        id: rendered.id,
        text: rendered.text,
        dropped: rendered.dropped,
        unknowns: draft.unknowns,
      };
    },
  ),
];

export function toolByName(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}
