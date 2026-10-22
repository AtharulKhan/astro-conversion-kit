// What styles.mjs samples: the first match of each selector, and the computed
// properties compared on it.

export const SELECTORS = [
  'h1', 'h2', 'h3', 'h4', 'p', 'a', 'button', '.btn', '[class*=button]', 'nav a',
  'input', 'textarea', 'select', 'blockquote', 'li', 'header', 'footer',
];

// kind: 'family' compares the first family, 'length' allows LENGTH_TOLERANCE_PX,
// 'exact' (colours, weights, keywords) must match exactly.
export const PROPERTIES = [
  { name: 'font-family', kind: 'family' },
  { name: 'font-size', kind: 'length' },
  { name: 'font-weight', kind: 'exact' },
  { name: 'line-height', kind: 'length' },
  { name: 'letter-spacing', kind: 'length' },
  { name: 'color', kind: 'exact' },
  { name: 'background-color', kind: 'exact' },
  { name: 'text-transform', kind: 'exact' },
  { name: 'margin-top', kind: 'length' },
  { name: 'margin-bottom', kind: 'length' },
  { name: 'padding-top', kind: 'length' },
  { name: 'padding-right', kind: 'length' },
  { name: 'padding-bottom', kind: 'length' },
  { name: 'padding-left', kind: 'length' },
];

export const LENGTH_TOLERANCE_PX = 1;
