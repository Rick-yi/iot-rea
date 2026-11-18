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

function configuredOrPath(setting: string, tool: string): boolean {
  const configured = process.env[setting];
  if (configured !== undefined && configured !== '') return path.isAbsolute(configured) && existsSync(configured);
  return onPath(tool);
}

const required = process.env.IOT_REA_REQUIRE_TOOLS === '1';

describe('toolchain', () => {
  it.skipIf(!required)('external tools are available when the run requires tools', () => {
    expect(configuredOrPath('IOT_REA_TSHARK', 'tshark')).toBe(true);
    expect(configuredOrPath('IOT_REA_SIGROK', 'sigrok-cli')).toBe(true);
  });
});
