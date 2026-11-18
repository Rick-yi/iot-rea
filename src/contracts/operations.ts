/**
 * Operation registry: the seam a future MCP adapter binds to.
 *
 * Each operation declares a stable name, an input schema and a handler. CLI
 * argument translation lives in src/cli.ts and never inside the handler, so a
 * later MCP server can expose the same operations without re-implementing them.
 */
import { z } from 'zod';
import type { Evidence } from './evidence.js';

export interface Operation<I, O> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  run: (input: I) => Promise<{ result: O; evidence: Evidence }>;
}

export interface OperationSummary {
  name: string;
  description: string;
  inputSchema: unknown;
}

export function summarize<I, O>(op: Operation<I, O>): OperationSummary {
  // zod-to-json-schema is deliberately not a dependency in v1: the registry
  // exposes the Zod schema object, which an MCP adapter can convert later.
  return { name: op.name, description: op.description, inputSchema: op.input };
}
