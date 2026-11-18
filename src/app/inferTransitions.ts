/**
 * Transition graph inference (experimental).
 *
 * This is deliberately not called a "state machine": it groups consecutive
 * frames by channel and first N signature bytes, then counts observed edges.
 * It does not claim to recover hidden state, variables or protocol semantics.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Evidence } from '../contracts/evidence.js';
import { IotReaError } from '../contracts/errors.js';
import { parseHex, toHex } from '../domain/frame.js';
import { fileSize, sha256File } from '../providers/process.js';

export const inferTransitionsInputSchema = z.object({
  path: z.string().min(1),
  signatureBytes: z.number().int().min(1).max(16).optional(),
  channel: z.string().min(1).optional(),
});

export type InferTransitionsInput = z.infer<typeof inferTransitionsInputSchema>;

const frameInputSchema = z.object({
  frameId: z.string().min(1).optional(),
  nativeId: z.string().min(1).optional(),
  timestampMs: z.number().nullable().optional(),
  direction: z.string().optional(),
  channel: z.string().optional(),
  hex: z.string().min(2),
});

type Direction = 'tx' | 'rx' | 'unknown';

interface NormalizedFrame {
  frameId: string;
  timestampMs: number | null;
  direction: Direction;
  channel: string;
  bytes: Buffer;
}

export interface TransitionNode {
  id: string;
  channel: string;
  direction: Direction;
  signature: string;
  count: number;
  frameIds: string[];
}

export interface TransitionEdge {
  from: string;
  to: string;
  count: number;
  frameIds: string[];
}

export interface TransitionGraph {
  nodes: TransitionNode[];
  edges: TransitionEdge[];
  unknowns: string[];
  mermaid: string;
  stats: {
    frames: number;
    channels: number;
    edges: number;
    singleObservationEdges: number;
    unknownDirection: number;
  };
}

export interface InferTransitionsResult extends TransitionGraph {
  evidence: Evidence;
}

export async function loadFrameFile(pathname: string): Promise<{ frames: NormalizedFrame[]; digest: string; size: number }> {
  const size = await fileSize(pathname);
  const digest = await sha256File(pathname);
  let text: string;
  try {
    text = await readFile(pathname, 'utf8');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `cannot read frames at ${pathname}: ${message}`, { path: pathname });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new IotReaError('invalid_request', `frames are not valid JSON: ${message}`, { path: pathname });
  }

  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { frames?: unknown }).frames)
      ? (raw as { frames: unknown[] }).frames
      : null;
  if (list === null) {
    throw new IotReaError('invalid_request', 'frames must be an array or {"frames": [...]}');
  }

  const frames: NormalizedFrame[] = [];
  for (const [index, entry] of list.entries()) {
    const parsed = frameInputSchema.parse(entry);
    const bytes = parseHex(parsed.hex);
    if (bytes === null) {
      throw new IotReaError('invalid_request', `frame ${index + 1} has an invalid hex payload`);
    }
    frames.push({
      frameId: parsed.frameId ?? parsed.nativeId ?? `#${index + 1}`,
      timestampMs: parsed.timestampMs ?? null,
      direction: normalizeDirection(parsed.direction),
      channel: parsed.channel ?? 'default',
      bytes,
    });
  }

  return { frames, digest, size };
}

export function buildTransitionGraph(
  frames: NormalizedFrame[],
  options: { signatureBytes?: number; channel?: string } = {},
): TransitionGraph {
  const signatureBytes = options.signatureBytes ?? 2;
  const selected = options.channel === undefined ? frames : frames.filter((frame) => frame.channel === options.channel);

  const ordered = orderFrames(selected);
  const unknowns: string[] = [];
  if (!ordered.hasTimestamps) {
    unknowns.push('timestamps are missing for at least one frame; file order is assumed, not proven');
  }

  const nodeMap = new Map<string, TransitionNode>();
  const edgeMap = new Map<string, TransitionEdge>();
  const previousByChannel = new Map<string, string>();
  let unknownDirection = 0;

  for (const frame of ordered.frames) {
    if (frame.direction === 'unknown') unknownDirection += 1;

    const signature = toHex(frame.bytes.subarray(0, signatureBytes));
    const nodeId = `${frame.channel}|${frame.direction}|${signature}`;
    const node = nodeMap.get(nodeId) ?? {
      id: nodeId,
      channel: frame.channel,
      direction: frame.direction,
      signature,
      count: 0,
      frameIds: [],
    };
    node.count += 1;
    if (node.frameIds.length < 20) node.frameIds.push(frame.frameId);
    nodeMap.set(nodeId, node);

    const previous = previousByChannel.get(frame.channel);
    if (previous !== undefined && previous !== nodeId) {
      const edgeId = `${previous}->${nodeId}`;
      const edge = edgeMap.get(edgeId) ?? { from: previous, to: nodeId, count: 0, frameIds: [] };
      edge.count += 1;
      if (edge.frameIds.length < 20) edge.frameIds.push(frame.frameId);
      edgeMap.set(edgeId, edge);
    }
    previousByChannel.set(frame.channel, nodeId);
  }

  const channels = new Set(selected.map((frame) => frame.channel));
  for (const channel of channels) {
    const count = selected.filter((frame) => frame.channel === channel).length;
    if (count === 1) unknowns.push(`channel "${channel}" has a single frame; no transition can be observed`);
  }

  const edges = [...edgeMap.values()].filter((edge) => edge.from !== edge.to);
  const singleObservationEdges = edges.filter((edge) => edge.count === 1).length;
  if (singleObservationEdges > 0) {
    unknowns.push(`${singleObservationEdges} edge(s) were observed once; they may be noise or rare paths`);
  }
  if (unknownDirection > 0) {
    unknowns.push(`${unknownDirection} frame(s) have an unknown direction; their signatures are separated but the direction is not established`);
  }
  unknowns.push(
    `signature uses the first ${signatureBytes} byte(s) only; frames sharing a prefix collapse into one node`,
  );

  const nodes = [...nodeMap.values()];
  return {
    nodes,
    edges,
    unknowns,
    mermaid: renderMermaid(nodes, edges),
    stats: {
      frames: selected.length,
      channels: channels.size,
      edges: edges.length,
      singleObservationEdges,
      unknownDirection,
    },
  };
}

export async function inferTransitions(input: InferTransitionsInput): Promise<InferTransitionsResult> {
  const parsed = inferTransitionsInputSchema.parse(input);
  const loaded = await loadFrameFile(parsed.path);
  const graph = buildTransitionGraph(loaded.frames, {
    signatureBytes: parsed.signatureBytes,
    channel: parsed.channel,
  });

  return {
    ...graph,
    evidence: {
      source: { path: parsed.path, sha256: loaded.digest, size: loaded.size },
      limitations: [
        'the graph counts observed transitions; it is not a hidden-state model',
        'missing timestamps mean file order, not observed order',
        ...graph.unknowns,
      ],
    },
  };
}

function orderFrames(frames: NormalizedFrame[]): { frames: NormalizedFrame[]; hasTimestamps: boolean } {
  const hasTimestamps = frames.every((frame) => frame.timestampMs !== null);
  if (!hasTimestamps) return { frames, hasTimestamps };
  return {
    frames: [...frames].sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0)),
    hasTimestamps,
  };
}

function normalizeDirection(value: string | undefined): Direction {
  if (value === undefined) return 'unknown';
  const lower = value.toLowerCase();
  if (lower === 'tx' || lower === 'out' || lower === '->') return 'tx';
  if (lower === 'rx' || lower === 'in' || lower === '<-') return 'rx';
  return 'unknown';
}

function renderMermaid(nodes: TransitionNode[], edges: TransitionEdge[]): string {
  const ids = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  const lines = ['flowchart LR'];
  for (const node of nodes) {
    const label = `${node.channel} / ${node.direction} / ${node.signature}`.replace(/"/g, "'");
    lines.push(`  ${ids.get(node.id)}["${label}" x${node.count}]`);
  }
  for (const edge of edges) {
    lines.push(`  ${ids.get(edge.from)} -->|${edge.count}| ${ids.get(edge.to)}`);
  }
  return `${lines.join('\n')}\n`;
}
