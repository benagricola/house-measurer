// Theme handling: one source of truth for light/dark. CSS reads the
// data-theme attribute on <html>; the canvases cannot, so they get their
// palettes from here via setTheme callbacks registered by main.js.

const KEY = 'house-measurer.theme';

// Colors the plan canvas draws with (three.js hex numbers, not CSS).
export const PLAN_PALETTES = {
  light: {
    bg: 0xf6f4ee,
    colors: {
      gridMinor: 0xe8e4d9,
      gridMajor: 0xd6d0bf,
      segment: 0x8a867a,
      ray: 0xb0aa9c,
      wall: 0x3a3a40,
      wallActive: 0xe8960c,
      wallGhost: 0xc4beae,
      ghostpt: 0xb5af9f,
      circle: 0xc9c3b2,
      anchor: 0x1f2a44,
      point: 0x0e7a6f,
      error: 0xc0392b,
      refRing: 0xe8960c,
      lastRing: 0x9fbfba,
      ghost: 0x0e7a6f,
      halo: 0xe8960c,
      handle: 0xe8960c,
    },
  },
  dark: {
    bg: 0x15161b,
    colors: {
      gridMinor: 0x1d1f26,
      gridMajor: 0x2b2e36,
      segment: 0x8a867a,
      ray: 0x5f5c54,
      wall: 0xd6d4cc,
      wallActive: 0xe8960c,
      wallGhost: 0x3c3f47,
      ghostpt: 0x565a63,
      circle: 0x43464f,
      anchor: 0x9db4dd,
      point: 0x2aa896,
      error: 0xd95c4d,
      refRing: 0xe8960c,
      lastRing: 0x3f6a64,
      ghost: 0x2aa896,
      halo: 0xe8960c,
      handle: 0xe8960c,
    },
  },
};

// 3D sky gradient + fog per theme (the scene itself stays daylight-lit;
// only the backdrop dims so dark mode is not a white blast).
export const SKY_PALETTES = {
  light: { stops: ['#f4efe3', '#eae4d4', '#ded7c4'], fog: 0xe2dbc9 },
  dark: { stops: ['#272a33', '#1d1f26', '#15161b'], fog: 0x1d1f26 },
};

export function storedTheme() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function currentTheme() {
  const t = storedTheme();
  if (t === 'light' || t === 'dark') return t;
  return matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Applies the theme to the document and persists an explicit choice.
// Returns the applied theme name.
export function applyTheme(theme, { persist = false } = {}) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#1d1f26' : '#f6f4ee';
  if (persist) {
    try { localStorage.setItem(KEY, theme); } catch {}
  }
  return theme;
}
