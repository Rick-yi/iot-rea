/**
 * Local development may skip integration tests when a tool is absent. CI must
 * not: with IOT_REA_REQUIRE_TOOLS=1, a missing tool fails the run instead of
 * silently reducing coverage.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function onPath(tool: string): boolean {
  const entries = (process.env.PATH ?? '').split(path.delimiter);
  const candidates = process.platform === 'win32'
    ? [`${tool}.exe`, `${tool}.cmd`, `${tool}.bat`, tool]
    : [tool];
  return entries.some(
    (entry) => path.isAbsolute(entry) && candidates.some((name) => existsSync(path.join(entry, name))),
  );
}

function tsharkAvailable(): boolean {
  const configured = process.env.IOT_REA_TSHARK;
  if (configured !== undefined && configured !== '') return path.isAbsolute(configured) && existsSync(configured);
  return onPath('tshark');
}

const required = process.env.IOT_REA_REQUIRE_TOOLS === '1';

describe('toolchain', () => {
  it.skipIf(!required)('tshark is available when the run requires tools', () => {
    expect(tsharkAvailable()).toBe(true);
  });
});
