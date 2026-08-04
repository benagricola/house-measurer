// Bluetooth laser measure link (Web Bluetooth, Chrome on Android/ChromeOS).
//
// Reality of BLE laser meters: every brand has its own dialect. Leica
// DISTOs expose a documented distance characteristic (float32 metres).
// Bosch GLM/PLR use a framed serial protocol on one characteristic.
// Cheap meters mostly ship a UART clone (FFE0/FFE1 or Nordic UART) and
// send ASCII or little-endian binary. Strategy here:
//   1. connect to any device offering a known service,
//   2. subscribe to every notify characteristic we recognise,
//   3. decode with per-profile parsers, falling back to a heuristic that
//      finds ASCII numbers, float32 metres or uint32 millimetres in the
//      frame,
//   4. keep a raw hex log of recent frames so an unknown protocol can be
//      identified from real data and given an exact decoder.
//
// The decoded value only fills the active input field - the user still
// sees it and presses OK, so a mis-parse is visible, never silent.

// --- frame decoding (pure, unit-tested) ------------------------------------

const PLAUSIBLE_MIN = 0.02, PLAUSIBLE_MAX = 300; // metres

export function parseAsciiFrame(bytes) {
  let s = '';
  for (const b of bytes) s += b >= 32 && b < 127 ? String.fromCharCode(b) : ' ';
  const m = s.match(/(\d+\.\d+)\s*(m\b|meter)?/i);
  if (m) {
    const v = parseFloat(m[1]);
    if (v >= PLAUSIBLE_MIN && v <= PLAUSIBLE_MAX) return v;
  }
  const mm = s.match(/(\d{3,6})\s*mm\b/i);
  if (mm) {
    const v = parseInt(mm[1], 10) / 1000;
    if (v >= PLAUSIBLE_MIN && v <= PLAUSIBLE_MAX) return v;
  }
  return null;
}

export function parseFloat32Frame(bytes, offset = null) {
  const dv = new DataView(new Uint8Array(bytes).buffer);
  const offsets = offset != null ? [offset] : [...Array(Math.max(0, bytes.length - 3)).keys()];
  for (const o of offsets) {
    if (o + 4 > bytes.length) continue;
    const v = dv.getFloat32(o, true);
    if (isFinite(v) && v >= PLAUSIBLE_MIN && v <= PLAUSIBLE_MAX) {
      // Real readings are whole millimetres; after a float32 round-trip
      // they stay within ~0.05 mm even at 300 m. Arbitrary bytes that
      // happen to decode into range almost never do.
      const mm = v * 1000;
      if (Math.abs(mm - Math.round(mm)) < 0.05) return v;
    }
  }
  return null;
}

export function parseUint32mmFrame(bytes) {
  const dv = new DataView(new Uint8Array(bytes).buffer);
  for (let o = 0; o + 4 <= bytes.length; o++) {
    const v = dv.getUint32(o, true);
    if (v >= 20 && v <= 300000 && v % 1 === 0) {
      const metres = v / 1000;
      if (metres >= PLAUSIBLE_MIN && metres <= PLAUSIBLE_MAX) return metres;
    }
  }
  return null;
}

// Best-effort decode for an unknown meter.
export function parseAnyFrame(bytes) {
  return parseAsciiFrame(bytes) ?? parseFloat32Frame(bytes) ?? parseUint32mmFrame(bytes);
}

// Leica DISTO: distance characteristic is a bare float32 LE in metres.
export function parseDistoFrame(bytes) {
  if (bytes.length === 4) return parseFloat32Frame(bytes, 0);
  return parseFloat32Frame(bytes);
}

// --- known device profiles --------------------------------------------------

const PROFILES = [
  {
    name: 'Leica DISTO',
    service: '3ab10100-f831-4395-b29d-570977d5bf94',
    parse: parseDistoFrame,
  },
  {
    name: 'Bosch GLM/PLR',
    service: '02a6c0d0-0451-4000-b000-fb3210111989',
    parse: parseAnyFrame,
  },
  {
    name: 'UART meter',
    service: 0xffe0,
    parse: parseAnyFrame,
  },
  {
    name: 'Nordic UART meter',
    service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    parse: parseAnyFrame,
  },
];

export class LaserLink {
  constructor(cb = {}) {
    this.cb = cb;          // { onMeasurement(m), onStatus(text, cls), onRaw(hex) }
    this.device = null;
    this.connected = false;
    this.rawLog = [];      // recent frames as hex strings, newest last
    this._lastValue = null;
    this._lastAt = 0;
  }

  get available() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  get secureContextProblem() {
    if (typeof window === 'undefined') return null;
    if (!window.isSecureContext) {
      return 'Bluetooth needs HTTPS (or localhost). Open the app via its https:// address.';
    }
    if (!navigator.bluetooth) {
      return 'This browser has no Web Bluetooth - use Chrome on Android or ChromeOS.';
    }
    return null;
  }

  status(text, cls = '') { this.cb.onStatus?.(text, cls); }

  async connect() {
    const problem = this.secureContextProblem;
    if (problem) return this.status(problem, 'warn');
    try {
      this.status('Choose your laser measure in the picker...');
      this.device = await navigator.bluetooth.requestDevice({
        filters: PROFILES.map((p) => ({ services: [p.service] })),
        optionalServices: PROFILES.map((p) => p.service),
      });
      this.device.addEventListener('gattserverdisconnected', () => {
        this.connected = false;
        this.status('Laser disconnected', 'warn');
      });
      const server = await this.device.gatt.connect();
      let hooked = 0;
      for (const profile of PROFILES) {
        let service;
        try {
          service = await server.getPrimaryService(profile.service);
        } catch {
          continue;
        }
        const chars = await service.getCharacteristics();
        for (const ch of chars) {
          if (!ch.properties.notify && !ch.properties.indicate) continue;
          try {
            await ch.startNotifications();
            ch.addEventListener('characteristicvaluechanged', (e) => {
              this.handleFrame(new Uint8Array(e.target.value.buffer), profile);
            });
            hooked++;
          } catch {}
        }
        if (hooked) {
          this.connected = true;
          this.profile = profile;
          this.status(`Laser connected (${this.device.name || profile.name}) - take a reading`, 'good');
          return;
        }
      }
      this.status('Connected, but no readable measurement channel found - frames will be logged for decoding', 'warn');
      this.connected = hooked > 0;
    } catch (e) {
      // Brave ships Web Bluetooth disabled (fingerprinting protection):
      // requestDevice rejects without ever showing a chooser.
      if (navigator.brave && (e.name === 'SecurityError' || e.name === 'NotFoundError')) {
        return this.status('Brave blocks Web Bluetooth by default: enable brave://flags/#brave-web-bluetooth-api and restart, or use Chrome.', 'warn');
      }
      this.status(e.name === 'NotFoundError' ? 'No device chosen' : `Bluetooth: ${e.message}`, 'warn');
    }
  }

  disconnect() {
    try { this.device?.gatt?.disconnect(); } catch {}
    this.connected = false;
    this.status('Laser disconnected');
  }

  handleFrame(bytes, profile) {
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    this.rawLog.push(hex);
    if (this.rawLog.length > 24) this.rawLog.shift();
    this.cb.onRaw?.(hex);
    const v = profile.parse(bytes);
    if (v == null) return;
    // Meters often repeat frames; drop identical values arriving in a burst.
    const now = Date.now();
    if (this._lastValue === v && now - this._lastAt < 800) return;
    this._lastValue = v;
    this._lastAt = now;
    this.cb.onMeasurement?.(v);
  }
}
