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

// Bosch GLM family (MT protocol): responses carry the distance as a
// uint32 LE in 0.05 mm units, typically after a 2-3 byte status/length
// header (community-documented for GLM 50 C and relatives). Tried before
// the generic heuristics because those would misread 0.05 mm units.
export function parseBoschFrame(bytes) {
  if (bytes.length >= 6) {
    const dv = new DataView(new Uint8Array(bytes).buffer);
    for (const o of [2, 3, 4]) {
      if (o + 4 > bytes.length) continue;
      const raw = dv.getUint32(o, true);
      const metres = raw * 0.05 / 1000;
      if (raw > 0 && metres >= PLAUSIBLE_MIN && metres <= PLAUSIBLE_MAX) return metres;
    }
  }
  return parseAnyFrame(bytes);
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
    parse: parseBoschFrame,
  },
  {
    name: 'Bosch (new DIY line)',
    service: '00005301-0000-0041-5253-534f46540000',
    parse: parseBoschFrame,
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
    // Access to a service after connecting requires it to be listed here,
    // even when the chooser matched on name.
    const optionalServices = PROFILES.map((p) => p.service);
    try {
      this.status('Choose your laser measure in the picker...');
      this.device = await navigator.bluetooth.requestDevice(this._allDevicesNext
        ? { acceptAllDevices: true, optionalServices }
        : {
          // Most meters do NOT advertise their measurement service UUID,
          // only a name - so filter primarily by name prefix.
          filters: [
            ...PROFILES.map((p) => ({ services: [p.service] })),
            { namePrefix: 'Bosch' }, { namePrefix: 'GLM' }, { namePrefix: 'PLR' },
            { namePrefix: 'Universal' }, { namePrefix: 'UD' },
            { namePrefix: 'Leica' }, { namePrefix: 'DISTO' },
          ],
          optionalServices,
        });
      this._allDevicesNext = false;
      this.device.addEventListener('gattserverdisconnected', () => {
        this.connected = false;
        this.status('Laser disconnected', 'warn');
      });
      const server = await this.device.gatt.connect();
      // Discovery mode: hook every notify characteristic we are allowed to
      // see; decode with the matching profile parser or the heuristic.
      let services = [];
      try { services = await server.getPrimaryServices(); } catch {}
      let hooked = 0;
      let pokeTarget = null;
      for (const service of services) {
        const uuid = service.uuid;
        const profile = PROFILES.find((p) =>
          typeof p.service === 'string' ? p.service === uuid : uuid.startsWith('0000ffe0'));
        let chars = [];
        try { chars = await service.getCharacteristics(); } catch { continue; }
        for (const ch of chars) {
          if (ch.properties.write || ch.properties.writeWithoutResponse) {
            if (!pokeTarget) pokeTarget = ch;
          }
          if (!ch.properties.notify && !ch.properties.indicate) continue;
          try {
            await ch.startNotifications();
            const parse = profile?.parse ?? parseAnyFrame;
            const tag = ch.uuid.slice(4, 8);
            ch.addEventListener('characteristicvaluechanged', (e) => {
              this.handleFrame(new Uint8Array(e.target.value.buffer), { parse }, tag);
            });
            hooked++;
          } catch {}
        }
      }
      this.connected = hooked > 0;
      if (hooked) {
        this.status(`Laser connected (${this.device.name || 'unnamed'}) - take a reading on the device`, 'good');
        // Bosch GLM-family meters stay silent until asked: the documented
        // MT-protocol measurement request is harmless elsewhere (framed
        // protocols ignore frames that fail their checksum).
        if (pokeTarget) {
          setTimeout(() => {
            pokeTarget.writeValue(new Uint8Array([0xc0, 0x40, 0x00, 0xee])).catch(() => {});
          }, 600);
        }
      } else {
        this.status('Connected, but the device exposed no readable channel - tell the developer the model; frames may need a different service listed', 'warn');
      }
    } catch (e) {
      // Brave ships Web Bluetooth disabled (fingerprinting protection):
      // requestDevice rejects without ever showing a chooser.
      if (navigator.brave && (e.name === 'SecurityError' || e.name === 'NotFoundError')) {
        return this.status('Brave blocks Web Bluetooth by default: enable brave://flags/#brave-web-bluetooth-api and restart, or use Chrome.', 'warn');
      }
      if (e.name === 'NotFoundError') {
        this._allDevicesNext = true;
        return this.status('No device chosen. If yours was not listed, tap laser again - the next picker shows ALL Bluetooth devices.', 'warn');
      }
      this.status(`Bluetooth: ${e.message}`, 'warn');
    }
  }

  disconnect() {
    try { this.device?.gatt?.disconnect(); } catch {}
    this.connected = false;
    this.status('Laser disconnected');
  }

  handleFrame(bytes, profile, tag = '') {
    const hex = (tag ? tag + ': ' : '')
      + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
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
