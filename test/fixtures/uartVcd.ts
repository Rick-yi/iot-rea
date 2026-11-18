/**
 * Minimal VCD generator for a UART TX/RX line (8N1, LSB first).
 *
 * Used to exercise the real sigrok-cli path in CI without shipping binary
 * recordings. One channel named RX, idle high, one start bit, eight data bits,
 * one stop bit, then a configurable idle gap.
 */
export interface UartVcdOptions {
  baud?: number;
  /** Idle bit times inserted between bytes. */
  gapBits?: number;
}

export function buildUartVcd(bytes: number[], options: UartVcdOptions = {}): string {
  const baud = options.baud ?? 9600;
  const gapBits = options.gapBits ?? 4;
  // 1 µs timescale keeps the sample count small enough for the decoder.
  const bitUs = Math.round(1_000_000 / baud);
  const transitions: Array<{ time: number; level: 0 | 1 }> = [{ time: 0, level: 1 }];

  let cursor = 0;
  for (const byte of bytes) {
    transitions.push({ time: cursor, level: 0 }); // start bit
    for (let bit = 0; bit < 8; bit += 1) {
      const level = ((byte >> bit) & 1) === 1 ? 1 : 0;
      transitions.push({ time: cursor + (1 + bit) * bitUs, level });
    }
    transitions.push({ time: cursor + 9 * bitUs, level: 1 }); // stop bit
    cursor += (10 + gapBits) * bitUs;
    transitions.push({ time: cursor, level: 1 });
  }

  const header = [
    '$timescale 1 us $end',
    '$scope module logic $end',
    '$var wire 1 ! RX $end',
    '$upscope $end',
    '$enddefinitions $end',
    '#0',
    '$dumpvars',
    '1!',
    '$end',
  ];

  const body: string[] = [];
  let previousLevel: 0 | 1 = 1;
  for (const transition of transitions) {
    if (transition.level === previousLevel && transition.time !== 0) continue;
    body.push(`#${transition.time}`, `${transition.level}!`);
    previousLevel = transition.level;
  }

  return `${[...header, ...body].join('\n')}\n`;
}
