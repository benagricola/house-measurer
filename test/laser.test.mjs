import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAsciiFrame, parseFloat32Frame, parseUint32mmFrame, parseAnyFrame,
  parseDistoFrame, parseBoschFrame, parseBoschStrict,
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

test('remote-trigger replies get the reference-edge offset; pushes do not', async () => {
  const { LaserLink } = await import('../js/laser.js');
  const got = [];
  const ll = new LaserLink({ onMeasurement: (m) => got.push(m) });
  ll.boschChar = {}; // Bosch control channel present
  ll.remoteOffset = 0.1;
  // Remote reply: 3141 ticks = 0.15705 m + 0.100 offset.
  ll.handleFrame(new Uint8Array([0x00, 0x04, 0x45, 0x0c, 0x00, 0x00, 0x60]), { parse: parseBoschStrict });
  close(got[0], 0.25705, 1e-6);
  // Push indication (button press): no offset.
  ll.handleFrame(new Uint8Array([0xc0, 0x55, 0x10, 0x06, 0, 0, 0, ...f32(3.425), 0x9a]), { parse: parseBoschStrict });
  close(got[1], 3.425, 1e-6);
});

test('reference edge is read from push frames; front edge disables the remote offset', async () => {
  const { LaserLink } = await import('../js/laser.js');
  const got = [], msgs = [];
  const ll = new LaserLink({ onMeasurement: (m) => got.push(m), onStatus: (t) => msgs.push(t) });
  ll.boschChar = {};
  ll.remoteOffset = 0.1;
  // Real frames captured from a UniversalDistance 50C while flipping the
  // reference-edge setting: byte 3 is 0x06 (back edge) / 0x04 (front).
  const backPush = [0xc0, 0x55, 0x10, 0x06, 0x00, 0x5b, 0x00, 0x23, 0x4a, 0x9b, 0x3e,
    0, 0, 0, 0, 0, 0, 0, 0, 0x44];
  const frontPush = [0xc0, 0x55, 0x10, 0x04, 0x00, 0x5c, 0x00, 0x7d, 0x1d, 0x58, 0x3e,
    0, 0, 0, 0, 0, 0, 0, 0, 0x92];
  const fval = (b) => new DataView(new Uint8Array(b).buffer).getFloat32(7, true);

  ll.handleFrame(new Uint8Array(backPush), { parse: parseBoschStrict });
  assert.equal(ll.deviceRef, 'back');
  close(got[0], fval(backPush), 1e-9);
  // Remote reply while on back edge: corrected by the offset.
  ll.handleFrame(new Uint8Array([0x00, 0x04, 0x45, 0x0c, 0x00, 0x00, 0x60]), { parse: parseBoschStrict });
  close(got[1], 0.15705 + 0.1, 1e-9);

  ll.handleFrame(new Uint8Array(frontPush), { parse: parseBoschStrict });
  assert.equal(ll.deviceRef, 'front');
  close(got[2], fval(frontPush), 1e-9);
  assert.ok(msgs.some((t) => /reference edge/.test(t) && /FRONT/.test(t)), 'change is announced');
  // Remote reply while on front edge: raw, no correction - button
  // readings are front-edge too, so they already agree.
  ll.handleFrame(new Uint8Array([0x00, 0x04, 0x45, 0x0c, 0x00, 0x00, 0x60]), { parse: parseBoschStrict });
  close(got[3], 0.15705, 1e-9);
});

test('Bosch strict: only known frames decode; the auto-sync ACK is ignored', () => {
  // The real ACK captured from a UniversalDistance 50C - its status bytes
  // decode to ~22.9 m under the legacy heuristic and must NOT surface.
  const ack = [0x00, 0x10, 0x02, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xd8];
  assert.equal(parseBoschStrict(ack), null);
  assert.notEqual(parseBoschFrame(ack), null, 'legacy parser would have surfaced it');
  close(parseBoschStrict([0xc0, 0x55, 0x10, 0x06, 0, 0, 0, ...f32(3.425), 0x9a]), 3.425);
  // Real remote-trigger reply captured live: 0x0C45 = 3141 ticks of
  // 0.05 mm = 0.15705 m.
  close(parseBoschStrict([0x00, 0x04, 0x45, 0x0c, 0x00, 0x00, 0x60]), 0.15705);
  assert.equal(parseBoschStrict([0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x5c]), null, 'zero = no measurement');
  assert.equal(parseBoschStrict(ascii('2.345')), null, 'no heuristic fallback');
});

test('Bosch frames: 50-27/UniversalDistance indication and legacy MT reply', () => {
  // New generation: c0 55 10 06 header, float32 LE metres at bytes 7..10.
  const frame = [0xc0, 0x55, 0x10, 0x06, 0x00, 0x00, 0x00, ...f32(3.4257), 0x9a];
  close(parseBoschFrame(frame), 3.4257);
  // Non-mm float values must survive (no resolution gate on exact frames).
  close(parseBoschFrame([0xc0, 0x55, 0x10, 0x06, 0, 0, 0, ...f32(1.2345678), 0]), 1.2345678, 1e-6);
  // Short reply frame: uint32 LE in 0.05 mm ticks (2.618 m = 52360).
  close(parseBoschFrame([0x00, 0x04, 0x88, 0xcc, 0x00, 0x00, 0x5c]), 2.618);
  // Its 0.0 payload means "no measurement" - must not produce a value.
  assert.equal(parseBoschFrame([0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x5c]), null);
  // Legacy reply: uint32 LE in 0.05 mm units after a 2-byte header.
  close(parseBoschFrame([0x00, 0x10, 0x94, 0x0b, 0x01, 0x00, 0x1a]), 3.425);
  // Falls back to the generic heuristic for anything else.
  close(parseBoschFrame([...'2.345'].map((c) => c.charCodeAt(0))), 2.345);
});
