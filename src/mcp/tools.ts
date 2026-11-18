/**
 * Transport-neutral MCP tool definitions.
 *
 * Keeping the handlers free of SDK imports lets unit tests exercise schemas and
 * error mapping without a live connection; src/mcp/server.ts only binds these
 * definitions to the protocol.
 */
import { z } from 'zod';
import { doctor } from '../app/doctor.js';
import { diffFrames } from '../app/diffFrames.js';
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
): McpTool {
  const inputSchema = z.object(shape);
  return {
    name,
    title,
    description,
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
];

export function toolByName(name: string): McpTool | undefined {
  return MCP_TOOLS.find((tool) => tool.name === name);
}
