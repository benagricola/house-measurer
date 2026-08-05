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

// Bosch GLM 50-27 / UniversalDistance 50C generation: after writing the
// auto-sync enable command (BOSCH_AUTOSYNC), each press of the measure
// button sends an indication starting c0 55 10 06 with the distance as a
// float32 LE in METRES at bytes 7..10 (community reverse engineering of
// the 50-27CG). No mm-resolution gate here: the header identifies the
// frame, and Bosch's floats are not necessarily whole millimetres.
export const BOSCH_AUTOSYNC = [0xc0, 0x55, 0x02, 0x01, 0x00, 0x1a];
// Classic GLM frame commands ([start][command][length][checksum]) - the
// UniversalDistance replies to these with status 0x00, so they are
// understood; remote measurement needs the laser armed first.
export const BOSCH_LASER_ON = [0xc0, 0x41, 0x00, 0x96];
export const BOSCH_TRIGGER = [0xc0, 0x40, 0x00, 0xee];
// MT readSettings (0x53, read-only; CRC-8 poly 0xA6 init 0xAA over the
// whole frame). Confirmed live on a UniversalDistance 50C: the reply is
// an EMPTY ok (00 00 82) - this generation has no readable settings
// container. The reference edge rides in every push frame instead (see
// handleFrame), so nothing sends this any more; kept for documentation.
export const BOSCH_READ_SETTINGS = [0xc0, 0x53, 0x00, 0xd8];

// Strict decoder for the UniversalDistance/AdvancedDistance generation:
// ONLY the two known measurement frame shapes decode; every other frame
// (auto-sync ACKs, status frames) is ignored rather than guessed at -
// the ACK's status bytes can masquerade as a plausible distance under
// the heuristics.
export function parseBoschStrict(bytes) {
  const dv = new DataView(new Uint8Array(bytes).buffer);
  // Push indication after auto-sync (measure button): float32 LE metres.
  if (bytes.length >= 11 && bytes[0] === 0xc0 && bytes[1] === 0x55 && bytes[2] === 0x10) {
    const v = dv.getFloat32(7, true);
    if (isFinite(v) && v >= PLAUSIBLE_MIN && v <= PLAUSIBLE_MAX) return v;
  }
  // Reply to a remote trigger: uint32 LE in 0.05 mm ticks (confirmed live
  // against a UniversalDistance 50C; matches the GLM reference decoder).
  if (bytes.length >= 7 && bytes[0] === 0x00 && bytes[1] === 0x04) {
    const v = dv.getUint32(2, true) * 0.05 / 1000;
    if (v >= PLAUSIBLE_MIN && v <= PLAUSIBLE_MAX) return v;
  }
  return null;
}

export function parseBoschFrame(bytes) {
  const dv = new DataView(new Uint8Array(bytes).buffer);
  if (bytes.length >= 11 && bytes[0] === 0xc0 && bytes[1] === 0x55 && bytes[2] === 0x10) {
    const v = dv.getFloat32(7, true);
    if (isFinite(v) && v >= PLAUSIBLE_MIN && v <= PLAUSIBLE_MAX) return v;
  }
  // Short reply frame [status 0x00, len 0x04, uint32 LE 0.05 mm, crc] -
  // confirmed live; zero payload means "no measurement".
  if (bytes.length >= 7 && bytes[0] === 0x00 && bytes[1] === 0x04) {
    const v = dv.getUint32(2, true) * 0.05 / 1000;
    if (v >= PLAUSIBLE_MIN && v <= PLAUSIBLE_MAX) return v;
    if (v === 0) return null;
  }
  // Older GLM/PLR models answer measurement REQUESTS with uint32 LE in
  // 0.05 mm units after a short status header.
  if (bytes.length >= 6 && bytes[0] !== 0xc0) {
    for (const o of [2, 3]) {
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
    // Confirmed on a real UniversalDistance 50C: SIG-registered Robert
    // Bosch service 0xFDE8 holding vendor characteristic 02a6c0d2
    // (write-without-response + notify). Strict decoding: this device's
    // frames are fully known, so nothing gets guessed.
    name: 'Bosch UniversalDistance/AdvancedDistance',
    service: 0xfde8,
    parse: parseBoschStrict,
  },
  {
    name: 'Bosch (new DIY line)',
    service: '00005301-0000-0041-5253-534f46540000',
    parse: parseBoschStrict,
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
    // Remote-trigger replies measure from the FRONT edge of the device;
    // button measurements use the configured reference (back edge by
    // default). The difference is the meter's body length - observed as
    // exactly 100 mm on a UniversalDistance 50C. Adjustable in the data
    // sheet; applied to remote replies only.
    this.remoteOffset = 0.100;
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
    // The picker shows every device; the user is the filter. We can only
    // ACCESS services declared here though - so cast a wide net of vendor
    // UART/measurement services. chrome://bluetooth-internals reveals a
    // device's full service list when something outside this net turns up.
    const optionalServices = [
      ...PROFILES.map((p) => p.service),
      0xfff0, 0xffe5, 0xffb0,
      '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip Transparent UART
      0x180a, // Device Information
    ];
    try {
      this.status('Choose your laser measure in the picker...');
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices,
      });
      this.status('Connecting...');
      this.device.addEventListener('gattserverdisconnected', () => {
        this.connected = false;
        this.status('Laser disconnected', 'warn');
      });
      const server = await this.device.gatt.connect();
      // Discovery: getPrimaryServices() alone is flaky on some stacks, so
      // also probe every candidate service explicitly, with one retry for
      // the discovery race. Everything found is logged for diagnosis.
      const found = new Map();
      for (let attempt = 0; attempt < 2 && found.size === 0; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 1200));
        try {
          for (const s of await server.getPrimaryServices()) found.set(s.uuid, s);
        } catch {}
        for (const cand of optionalServices) {
          try {
            const s = await server.getPrimaryService(cand);
            found.set(s.uuid, s);
          } catch {}
        }
      }
      const svcList = [...found.keys()].map((u) => u.slice(0, 8)).join(', ') || 'none';
      this.rawLog.push(`services: ${svcList}`);
      this.cb.onRaw?.('');

      const svcUuid = (s) => (typeof s === 'string'
        ? s
        : `0000${s.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`);
      let hooked = 0;
      let pokeTarget = null;
      let boschChar = null;
      this.profileName = null;
      for (const service of found.values()) {
        const uuid = service.uuid;
        const profile = PROFILES.find((p) => svcUuid(p.service) === uuid);
        let chars = [];
        try { chars = await service.getCharacteristics(); } catch { continue; }
        for (const ch of chars) {
          if (ch.uuid.startsWith('02a6c0d1') || ch.uuid.startsWith('02a6c0d2')) boschChar = ch;
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
            if (profile && !this.profileName) this.profileName = profile.name;
          } catch {}
        }
      }
      this.connected = hooked > 0;
      if (hooked) {
        // The protocol details go to the frame log, not the status line -
        // the user just needs "connected" plus which device it is.
        this.boschChar = boschChar;
        this.rawLog.push(`protocol: ${this.profileName ?? 'generic'}${boschChar ? `, control ${boschChar.uuid.slice(0, 8)}` : ''}`);
        // Bosch meters stay silent until auto-sync is enabled on their
        // control characteristic; other meters get a harmless generic
        // poke (framed protocols drop checksum failures).
        setTimeout(() => {
          if (boschChar) this._write(boschChar, BOSCH_AUTOSYNC);
          else if (pokeTarget) this._write(pokeTarget, BOSCH_TRIGGER);
        }, 600);
        // Read model/maker first so the connected message can name the
        // device properly (the advertised name is often empty or cryptic).
        this.readDeviceInfo(server).catch(() => {}).then(() => {
          if (this.connected) this.status(`Laser connected: ${this.deviceLabel}`, 'good');
        });
      } else {
        this.status(`Connected, but no readable channel (services seen: ${svcList}). If the list is empty, pair the meter in the system Bluetooth settings first, then retry.`, 'warn');
      }
    } catch (e) {
      // Brave ships Web Bluetooth disabled (fingerprinting protection):
      // requestDevice rejects without ever showing a chooser.
      if (navigator.brave && (e.name === 'SecurityError' || e.name === 'NotFoundError')) {
        return this.status('Brave blocks Web Bluetooth by default: enable brave://flags/#brave-web-bluetooth-api and restart, or use Chrome.', 'warn');
      }
      if (e.name === 'NotFoundError') return this.status('No device chosen', 'warn');
      this.status(`Bluetooth: ${e.message}`, 'warn');
    }
  }

  disconnect() {
    try { this.device?.gatt?.disconnect(); } catch {}
    this.connected = false;
    this.boschChar = null;
    this.status('Laser disconnected');
  }

  // The Bosch char is write-WITHOUT-response only - the default write
  // mode fails on it.
  _write(ch, bytes) {
    const buf = new Uint8Array(bytes);
    const p = !ch.properties.write && ch.writeValueWithoutResponse
      ? ch.writeValueWithoutResponse(buf)
      : ch.writeValue(buf);
    return p.catch(() => {});
  }

  get canTrigger() { return this.connected && !!this.boschChar; }

  // Human name for the connected meter: GATT device-info model (plus the
  // maker when it is short enough to help), else the advertised name.
  get deviceLabel() {
    const i = this.info || {};
    if (i.model) {
      const maker = i.maker && i.maker.length <= 12 ? `${i.maker} ` : '';
      return `${maker}${i.model}`;
    }
    return this.device?.name || 'laser measure';
  }

  // Remote, shake-free measurement: arm the laser, then trigger. The
  // reading arrives through the normal notification path; if none does,
  // the meter kept 0.0 and remote measuring is off on this model.
  async remoteTrigger() {
    if (!this.canTrigger) return this.status('Remote trigger needs a connected Bosch meter', 'warn');
    const before = this._lastAt;
    this.status('Arming laser...');
    await this._write(this.boschChar, BOSCH_LASER_ON);
    await new Promise((r) => setTimeout(r, 450));
    await this._write(this.boschChar, BOSCH_TRIGGER);
    setTimeout(() => {
      if (this._lastAt === before) {
        this.status('No remote reading returned - this model may only measure from its own button', 'warn');
      }
    }, 2500);
  }

  async readDeviceInfo(server) {
    const info = {};
    const fields = [[0x2a24, 'model'], [0x2a25, 'serial'], [0x2a26, 'firmware'], [0x2a29, 'maker']];
    try {
      const svc = await server.getPrimaryService(0x180a);
      for (const [uuid, key] of fields) {
        try {
          const v = await (await svc.getCharacteristic(uuid)).readValue();
          info[key] = new TextDecoder().decode(v).replace(/\0+$/, '').trim();
        } catch {}
      }
    } catch {}
    this.info = info;
  }

  handleFrame(bytes, profile, tag = '') {
    const hex = (tag ? tag + ': ' : '')
      + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    this.rawLog.push(hex);
    if (this.rawLog.length > 24) this.rawLog.shift();
    this.cb.onRaw?.(hex);
    // Push frames broadcast the meter's reference-edge setting in byte 3
    // (payload byte 0): 0x06 = back edge, 0x04 = front edge - confirmed
    // by flipping the setting on a real UniversalDistance 50C and
    // diffing the frames. Byte 5 is a rolling sequence counter.
    if (bytes[0] === 0xc0 && bytes[1] === 0x55 && bytes[2] === 0x10 && bytes.length >= 11) {
      const ref = bytes[3] === 0x04 ? 'front' : bytes[3] === 0x06 ? 'back'
        : `0x${bytes[3].toString(16)}`;
      if (this.deviceRef && this.deviceRef !== ref) {
        this.status(`Meter reference edge is now ${ref === 'front' ? 'FRONT' : ref} - remote-shoot correction ${ref === 'front' ? 'off' : 'on'}`, 'warn');
      }
      this.deviceRef = ref;
    }
    let v = profile.parse(bytes);
    if (v == null) return;
    // Remote-trigger replies (00 04 ...) always measure from the front
    // edge, so they get the body-length correction - except when the
    // meter itself is set to front edge, because then button readings
    // are front-edge too and raw remote values already match them.
    if (this.boschChar && bytes[0] === 0x00 && bytes[1] === 0x04) {
      if (this.deviceRef !== 'front') v += this.remoteOffset || 0;
    }
    // Meters often repeat frames; drop identical values arriving in a burst.
    const now = Date.now();
    if (this._lastValue === v && now - this._lastAt < 800) return;
    this._lastValue = v;
    this._lastAt = now;
    this.cb.onMeasurement?.(v);
  }
}
