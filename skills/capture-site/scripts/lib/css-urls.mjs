// Asset URLs in a stylesheet: cssUrls(cssText, baseUrl) -> absolute URLs from url(), image and
// font files only (by extension), in order, without duplicates. data: URIs, @import targets,
// scripts and anything in a comment are left out. A fragment is dropped; a query is kept.
// cssImports(cssText, baseUrl) -> the absolute http(s) URLs of its @import rules, in order,
// without duplicates, whether written as url() or as a string.
import * as csstree from 'css-tree';
import { extensionOf } from './page-rules.mjs';

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tif', 'tiff', 'heic'];
export const FONT_EXTENSIONS = ['woff', 'woff2', 'ttf', 'otf', 'eot'];
const ASSET_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...FONT_EXTENSIONS]);

export function cssUrls(cssText, baseUrl) {
  const ast = csstree.parse(String(cssText ?? ''), { parseValue: true, onParseError: () => {} });
  const found = [];
  const seen = new Set();
  csstree.walk(ast, {
    visit: 'Url',
    enter(node) {
      if (this.atrule && this.atrule.name.toLowerCase() === 'import') return;
      const value = String(node.value ?? '').trim();
      if (!value || /^data:/i.test(value)) return;
      let url;
      try {
        url = new URL(value, baseUrl);
      } catch {
        return;
      }
      if (!/^https?:$/.test(url.protocol) || !ASSET_EXTENSIONS.has(extensionOf(url.pathname))) return;
      url.hash = '';
      if (!url.search) url.search = '';
      if (seen.has(url.href)) return;
      seen.add(url.href);
      found.push(url.href);
    },
  });
  return found;
}

export function cssImports(cssText, baseUrl) {
  const ast = csstree.parse(String(cssText ?? ''), { onParseError: () => {} });
  const found = [];
  csstree.walk(ast, {
    visit: 'Atrule',
    enter(node) {
      if (node.name.toLowerCase() !== 'import' || !node.prelude?.children) return;
      const target = node.prelude.children.toArray().find((child) => child.type === 'Url' || child.type === 'String');
      if (!target) return;
      let url;
      try {
        url = new URL(String(target.value ?? '').trim(), baseUrl);
      } catch {
        return;
      }
      if (!/^https?:$/.test(url.protocol)) return;
      url.hash = '';
      if (!found.includes(url.href)) found.push(url.href);
    },
  });
  return found;
}
