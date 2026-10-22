// WordPress shortcodes printed as text because the plugin that rendered them is gone. A
// bracketed word counts when it is a known shortcode or page-builder prefix, has attributes,
// or has a closing tag; "[1]" and "[sic]" do not.
import { defineCheck } from '../lib/item.mjs';
import { listOf, okPages } from '../lib/pages.mjs';

const KNOWN = new Set([
  'gallery', 'caption', 'embed', 'audio', 'video', 'playlist', 'contact-form-7', 'contact-form', 'wpforms',
  'gravityform', 'ninja_form', 'formidable', 'rev_slider', 'layerslider', 'metaslider', 'smartslider3',
  'elementor-template', 'shortcode', 'button', 'row', 'column', 'col', 'tabs', 'tab', 'accordion', 'toggle',
]);
const BUILDER = /^(vc|et_pb|fusion|su|av|cs|tm|ux|mk|fl|tatsu|themify)_/i;
const PATTERN = /\[(\/?)([a-z][\w-]*)((?:\s+[\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\s\]]+))?)*)\s*\/?\]/gi;

export function shortcodes(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(PATTERN)) {
    const [whole, closing, name, attrs] = match;
    const lower = name.toLowerCase();
    if (KNOWN.has(lower) || BUILDER.test(lower) || closing || /=/.test(attrs)) found.push({ name: lower, text: whole });
  }
  return found;
}

export default defineCheck({
  id: 'shortcode-leftovers',
  title: 'Shortcodes showing as text',
  category: 'content',
  why: 'Replace the shortcode with the content it used to render (a gallery, a form, an embed), or delete it.',
  effort: 'M',
  risk: 'low',
  applyable: false,
  find(ctx) {
    const found = [];
    for (const r of okPages(ctx)) {
      const codes = shortcodes(r.text);
      if (!codes.length) continue;
      const texts = [...new Set(codes.map((c) => c.text))];
      found.push({ path: r.path, element: `[${codes[0].name}]`, evidence: `visible text contains ${listOf(texts)}` });
    }
    return found;
  },
});
