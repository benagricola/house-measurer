// Item categories, colours and quick presets. Pure data + tiny helpers.

export const CATEGORIES = {
  appliance:  { label: 'appliance',  color: 0x4a6fa5 },
  worktop:    { label: 'worktop',    color: 0x9a7b4f },
  cupboard:   { label: 'cupboard',   color: 0x7d9184 },
  shelf:      { label: 'shelf',      color: 0x5f8a5f },
  window:     { label: 'window',     color: 0x6fa7c7 },
  door:       { label: 'door',       color: 0x9a7a50 },
  radiator:   { label: 'radiator',   color: 0xa85454 },
  extraction: { label: 'extraction', color: 0x5b6770 },
  other:      { label: 'other',      color: 0x8a8a8a },
};

export function categoryColor(cat) {
  return (CATEGORIES[cat] || CATEGORIES.other).color;
}

// Categories that live on a wall (get a height-above-floor and a wall mount).
export const WALL_CATEGORIES = ['window', 'door', 'shelf', 'extraction', 'radiator', 'cupboard'];

// Dimensions in metres: w along the wall / long side, d out of the wall /
// short side, h vertical, z0 height of the underside above the floor.
export const PRESETS = [
  { name: 'fridge freezer', category: 'appliance', w: 0.7, d: 0.7, h: 1.8, z0: 0 },
  { name: 'washing machine', category: 'appliance', w: 0.6, d: 0.6, h: 0.85, z0: 0 },
  { name: 'oven + hob', category: 'appliance', w: 0.6, d: 0.6, h: 0.9, z0: 0 },
  { name: 'worktop run', category: 'worktop', w: 1.8, d: 0.62, h: 0.9, z0: 0 },
  { name: 'base cupboard', category: 'cupboard', w: 0.6, d: 0.58, h: 0.9, z0: 0 },
  { name: 'wall cupboard', category: 'cupboard', w: 0.8, d: 0.35, h: 0.7, z0: 1.4 },
  { name: 'shelf', category: 'shelf', w: 0.8, d: 0.25, h: 0.04, z0: 1.5 },
  { name: 'window', category: 'window', w: 1.0, d: 0.15, h: 1.1, z0: 0.9 },
  { name: 'door', category: 'door', w: 0.9, d: 0.15, h: 2.0, z0: 0 },
  { name: 'radiator', category: 'radiator', w: 1.0, d: 0.1, h: 0.6, z0: 0.15 },
  { name: 'cooker hood', category: 'extraction', w: 0.9, d: 0.5, h: 0.4, z0: 1.95 },
];
