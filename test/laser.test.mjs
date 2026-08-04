import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAsciiFrame, parseFloat32Frame, parseUint32mmFrame, parseAnyFrame,
  parseDistoFrame, parseBoschFrame,
} from '../js/laser.js';

const close = (a, b, eps = 1e-4) => assert.ok(a != null && Math.abs(a - b) < eps, `${a} !~ ${b}`);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const f32 = (v) => {
  const b = new ArrayBuffer(4);
  new DataView(b).setFloat32(0, v, true);
  return [...new Uint8Array(b)];
};

test('ascii frames: plain, labelled, mm, CR/LF, junk', () => {
  close(parseAsciiFrame(ascii('2.345')), 2.345);
  close(parseAsciiFrame(ascii('d=1.234m\r\n')), 1.234);
  close(parseAsciiFrame(ascii('DIST: 12.007 m ')), 12.007);
  close(parseAsciiFrame(ascii('3425 mm')), 3.425);
  assert.equal(parseAsciiFrame(ascii('battery 87%')), null);
  assert.equal(parseAsciiFrame(ascii('9999.9')), null); // implausible
});

test('float32 frames: bare and embedded, noise rejected', () => {
  close(parseFloat32Frame(f32(3.425)), 3.425);
  close(parseFloat32Frame([0xc0, 0x55, ...f32(2.007), 0x1a]), 2.007);
  assert.equal(parseFloat32Frame(f32(1234567)), null);
  // Non-mm-resolution float garbage is rejected by the resolution gate.
  assert.equal(parseFloat32Frame(f32(1.2345678)), null);
});

test('uint32 mm frames', () => {
  close(parseUint32mmFrame([0x61, 0x0d, 0x00, 0x00]), 3.425); // 3425 mm
  assert.equal(parseUint32mmFrame([0x00, 0x00, 0x00, 0x00]), null);
});

test('parseAnyFrame prefers ascii, then float32, then mm', () => {
  close(parseAnyFrame(ascii('1.111m')), 1.111);
  close(parseAnyFrame([0x00, ...f32(4.2)]), 4.2);
  close(parseAnyFrame([0x10, 0x27, 0x00, 0x00]), 10.0); // 10000 mm
  assert.equal(parseAnyFrame([0x01, 0x02]), null);
});

test('Leica DISTO frame: bare float32 metres', () => {
  close(parseDistoFrame(f32(7.654)), 7.654);
});

test('Bosch frames: 50-27/UniversalDistance indication and legacy MT reply', () => {
  // New generation: c0 55 10 06 header, float32 LE metres at bytes 7..10.
  const frame = [0xc0, 0x55, 0x10, 0x06, 0x00, 0x00, 0x00, ...f32(3.4257), 0x9a];
  close(parseBoschFrame(frame), 3.4257);
  // Non-mm float values must survive (no resolution gate on exact frames).
  close(parseBoschFrame([0xc0, 0x55, 0x10, 0x06, 0, 0, 0, ...f32(1.2345678), 0]), 1.2345678, 1e-6);
  // Legacy reply: uint32 LE in 0.05 mm units after a 2-byte header.
  close(parseBoschFrame([0x00, 0x10, 0x94, 0x0b, 0x01, 0x00, 0x1a]), 3.425);
  // Falls back to the generic heuristic for anything else.
  close(parseBoschFrame([...'2.345'].map((c) => c.charCodeAt(0))), 2.345);
});
