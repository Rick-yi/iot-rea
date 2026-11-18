/**
 * doctor: report host and tool readiness without pretending a missing tool
 * works. Missing producers are listed as limitations, not silent skips.
 */
import { IotReaError } from '../contracts/errors.js';
import { probeVersion, resolveExecutable } from '../providers/process.js';

export interface ToolStatus {
  name: string;
  setting: string;
  available: boolean;
  configuredPath: string | null;
  resolvedPath: string | null;
  versionBanner: string | null;
  reason: string | null;
}

export interface DoctorReport {
  node: { version: string; supported: boolean; required: string };
  tools: ToolStatus[];
  limitations: string[];
}

const REQUIRED_NODE = '>=22.12.0';

export async function doctor(): Promise<DoctorReport> {
  const nodeVersion = process.version;
  const supported = isSupportedNode(nodeVersion);

  const tools: ToolStatus[] = [];
  for (const tool of [
    { name: 'tshark', setting: 'IOT_REA_TSHARK', purpose: 'inspect-capture' },
    { name: 'sigrok-cli', setting: 'IOT_REA_SIGROK', purpose: 'decode-signals' },
  ]) {
    try {
      const resolved = await resolveExecutable(tool.name, process.env[tool.setting]);
      tools.push({
        name: tool.name,
        setting: tool.setting,
        available: true,
        configuredPath: resolved.configuredPath,
        resolvedPath: resolved.resolvedPath,
        versionBanner: await probeVersion(resolved.resolvedPath),
        reason: null,
      });
    } catch (cause) {
      const reason = cause instanceof IotReaError ? cause.message : String(cause);
      tools.push({
        name: tool.name,
        setting: tool.setting,
        available: false,
        configuredPath: process.env[tool.setting] ?? null,
        resolvedPath: null,
        versionBanner: null,
        reason: `${reason}; "${tool.purpose}" is unavailable`,
      });
    }
  }

  const limitations: string[] = [];
  if (!supported) limitations.push(`Node ${nodeVersion} is below the supported ${REQUIRED_NODE}`);
  for (const tool of tools) {
    if (!tool.available) limitations.push(`${tool.name} not found; set ${tool.setting} to an absolute path`);
  }

  return {
    node: { version: nodeVersion, supported, required: REQUIRED_NODE },
    tools,
    limitations,
  };
}

export function isSupportedNode(version: string): boolean {
  const match = version.replace(/^v/, '').match(/^(\d+)\.(\d+)/);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major >= 23 || (major === 22 && minor >= 12);
}
