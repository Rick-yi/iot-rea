/**
 * Draft Kaitai Struct export.
 *
 * The differential gives per-field hypotheses, not a complete grammar. The
 * exporter therefore emits a sequential layout with explicit unknown gaps,
 * keeps every inference's confidence in `doc`, and never guesses a field it
 * could not place. The result is a reviewable starting point, not a claim that
 * the protocol is fully understood.
 */
import { writeFile } from 'node:fs/promises';
import type { FieldCandidate, FieldType } from '../domain/inference.js';
import type { ChecksumCandidate } from '../domain/checksum.js';
import type { SchemaDraft } from './diffFrames.js';

export interface KaitaiOptions {
  /** meta.id; sanitized to a Kaitai-compatible identifier. */
  id?: string;
}

export interface KaitaiDraft {
  id: string;
  text: string;
  /** Hypotheses omitted because they overlapped a stronger field. */
  dropped: string[];
}

interface LayoutField {
  offset: number;
  width: number;
  id: string;
  /** Kaitai scalar type; omitted for `bytes` and `str`. */
  type?: string;
  size?: number;
  encoding?: string;
  doc: string;
  priority: number;
  /** Emit `repeat: expr` / `repeat-expr` for a bytes field sized by a count field. */
  repeatExpr?: string;
  /** Cursor position after this field when it is not offset + width. */
  endOffset?: number;
}

const SCALAR_TYPES: Record<Exclude<FieldType, 'ascii' | 'bcd2'>, (endian: 'be' | 'le' | null) => string> = {
  u8: () => 'u1',
  i8: () => 's1',
  u16: (endian) => (endian === 'le' ? 'u2le' : 'u2be'),
  i16: (endian) => (endian === 'le' ? 's2le' : 's2be'),
  u32: (endian) => (endian === 'le' ? 'u4le' : 'u4be'),
  i32: (endian) => (endian === 'le' ? 's4le' : 's4be'),
  f32: (endian) => (endian === 'le' ? 'f4le' : 'f4be'),
};

export function renderKaitai(draft: SchemaDraft, options: KaitaiOptions = {}): KaitaiDraft {
  const id = sanitizeId(options.id ?? 'inferred_frame');
  const dropped: string[] = [];
  const layout: LayoutField[] = [];

  // Stronger hypotheses win an overlap: higher confidence, then wider field.
  const candidates = [...draft.fields]
    .filter((field) => field.confidence >= 0.5)
    .sort((a, b) => a.offset - b.offset || b.confidence - a.confidence || b.width - a.width);

  for (const field of candidates) {
    if (layout.some((placed) => overlaps(placed, field))) {
      dropped.push(`${field.variable} @0x${field.offset.toString(16)} overlaps a stronger field`);
      continue;
    }
    layout.push(toLayout(field));
  }

  // Derived fields describe the frame itself; place them before checksums so
  // a detected length field appears in the sequence with its relation in doc.
  for (const derived of draft.derived) {
    if (layout.some((placed) => overlaps(placed, { offset: derived.offset, width: derived.width }))) {
      continue;
    }
    layout.push({
      offset: derived.offset,
      width: derived.width,
      id: sanitizeId(`length_${derived.relation}_${derived.offset}`),
      type:
        derived.type === 'u8'
          ? 'u1'
          : derived.endian === 'le'
            ? 'u2le'
            : 'u2be',
      doc:
        `derived ${derived.relation}; ${derived.matched}/${derived.total} samples matched; ` +
        'describes the frame, not payload semantics',
      priority: 0.9,
    });
  }

  // Repeated records: emit the count field plus a bytes array sized by it.
  for (const record of draft.records) {
    if (record.confidence < 0.9) continue;
    if (layout.some((placed) => overlaps(placed, { offset: record.offset, width: record.width }))) continue;

    const recordsStart = record.offset + record.width;
    const trailerStart = draft.differential.alignedLength - record.trailerBytes;
    if (trailerStart < recordsStart) continue;
    if (layout.some((placed) => placed.offset >= recordsStart && placed.offset < trailerStart)) continue;
    if (draft.checksums.some((checksum) => checksum.position >= recordsStart && checksum.position < trailerStart)) {
      continue;
    }

    const countId = sanitizeId(`record_count_${record.offset}`);
    layout.push({
      offset: record.offset,
      width: record.width,
      id: countId,
      type:
        record.type === 'u8'
          ? 'u1'
          : record.endian === 'le'
            ? 'u2le'
            : 'u2be',
      doc: `derived record count; ${record.stride}-byte records, ${record.trailerBytes}-byte trailer`,
      priority: 0.95,
    });
    layout.push({
      offset: recordsStart,
      width: record.stride,
      id: sanitizeId(`records_${record.offset}`),
      size: record.stride,
      doc: `repeated records sized by ${countId}`,
      priority: 0.9,
      repeatExpr: countId,
      endOffset: trailerStart,
    });
  }

  // Place checksums only where no inferred field already covers them.
  const seenPositions = new Set<number>();
  for (const checksum of draft.checksums) {
    if (checksum.confidence < 0.5) continue;
    if (seenPositions.has(checksum.position)) continue;
    seenPositions.add(checksum.position);
    if (layout.some((placed) => overlaps(placed, { offset: checksum.position, width: checksum.width }))) {
      continue;
    }
    layout.push(checksumLayout(checksum));
  }

  layout.sort((a, b) => a.offset - b.offset || b.width - a.width);

  const alignedLength = draft.differential.alignedLength;
  const seq: LayoutField[] = [];
  let cursor = 0;
  let gap = 0;

  for (const field of layout) {
    if (field.offset < cursor) continue;
    if (field.offset > cursor) {
      seq.push(reserved(cursor, field.offset - cursor, gap));
      gap += 1;
    }
    seq.push(field);
    cursor = field.endOffset ?? field.offset + field.width;
  }

  if (cursor < alignedLength) {
    seq.push(reserved(cursor, alignedLength - cursor, gap));
  }

  const lines: string[] = [
    '# Generated by iot-rea from differential inference. Review before use.',
    `# Samples: ${draft.sampleCount}; compared prefix: ${alignedLength} bytes.`,
    '# Every doc string is a hypothesis with its confidence; unplaced bytes stay',
    '# explicit unknowns instead of invented fields.',
  ];
  for (const unknown of draft.unknowns) lines.push(`# unknown: ${singleLine(unknown)}`);
  if (dropped.length > 0) {
    for (const note of dropped) lines.push(`# dropped: ${singleLine(note)}`);
  }
  lines.push('', 'meta:', `  id: ${id}`, '  file-extension: bin', '  encoding: UTF-8', '', 'seq:');

  for (const field of seq) {
    lines.push(`  - id: ${field.id}`);
    if (field.type !== undefined) lines.push(`    type: ${field.type}`);
    if (field.size !== undefined) lines.push(`    size: ${field.size}`);
    if (field.encoding !== undefined) lines.push(`    encoding: ${field.encoding}`);
    if (field.repeatExpr !== undefined) {
      lines.push('    repeat: expr');
      lines.push(`    repeat-expr: ${field.repeatExpr}`);
    }
    lines.push(`    doc: ${quote(field.doc)}`);
  }

  return { id, text: `${lines.join('\n')}\n`, dropped };
}

export function toLayout(field: FieldCandidate): LayoutField {
  const id = sanitizeId(field.variable);
  const base = `offset 0x${field.offset.toString(16)}, width ${field.width}, confidence ${field.confidence.toFixed(2)}`;
  const variable = `variable ${field.variable}`;

  if (field.type === 'ascii') {
    return {
      offset: field.offset,
      width: field.width,
      id,
      size: field.width,
      encoding: 'ASCII',
      doc: `${base}; ${variable}; ASCII text hypothesis`,
      priority: field.confidence,
    };
  }

  if (field.type === 'bcd2') {
    return {
      offset: field.offset,
      width: 2,
      id,
      size: 2,
      doc: `${base}; ${variable}; BCD hypothesis, decode in application code`,
      priority: field.confidence,
    };
  }

  return {
    offset: field.offset,
    width: field.width,
    id,
    type: SCALAR_TYPES[field.type](field.endian),
    doc: `${base}; ${variable}${field.transform?.kind === 'scaled' ? `; scaled by ${field.transform.factor}` : ''}`,
    priority: field.confidence,
  };
}

export function checksumLayout(checksum: ChecksumCandidate): LayoutField {
  const type =
    checksum.width === 1
      ? 'u1'
      : checksum.width === 2
        ? checksum.endian === 'le' ? 'u2le' : 'u2be'
        : checksum.endian === 'le' ? 'u4le' : 'u4be';
  return {
    offset: checksum.position,
    width: checksum.width,
    id: sanitizeId(`checksum_${checksum.algorithm}`),
    type,
    doc:
      `inferred ${checksum.algorithm} over 0x${checksum.coveredFrom.toString(16)}-` +
      `0x${checksum.coveredTo.toString(16)}; ${checksum.matched}/${checksum.total} samples matched; ` +
      'Kaitai does not validate it, verify in application code',
    priority: checksum.confidence,
  };
}

export async function exportKsy(
  draft: SchemaDraft,
  target: string,
  options: KaitaiOptions = {},
): Promise<KaitaiDraft & { path: string | null }> {
  const rendered = renderKaitai(draft, options);
  if (target === '-') {
    return { ...rendered, path: null };
  }
  await writeFile(target, rendered.text);
  return { ...rendered, path: target };
}

function reserved(offset: number, width: number, index: number): LayoutField {
  return {
    offset,
    width,
    id: `reserved_${offset.toString(16)}`,
    size: width,
    doc: `${width} byte(s) at 0x${offset.toString(16)} were not placed by any hypothesis (gap #${index})`,
    priority: 0,
  };
}

function overlaps(a: { offset: number; width: number }, b: { offset: number; width: number }): boolean {
  return a.offset < b.offset + b.width && b.offset < a.offset + a.width;
}

export function sanitizeId(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned === '') return 'field';
  return /^[0-9]/.test(cleaned) ? `f_${cleaned}` : cleaned;
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ');
}
