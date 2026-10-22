// Interaction-state selectors: the rules a script turns on (an open menu, an expanded accordion,
// an active tab) that coverage of a page at rest never sees used. A selector is a state selector
// when it holds a state class or attribute; its base is the selector with those, and every
// pseudo-class and pseudo-element, taken out: the element the state would style.
import * as csstree from 'css-tree';

// .open .is-open .menu-open .nav-open .active .is-active .expanded .show .visible .toggled
// .toggled-on .focus .selected, and any class ending -open, -opened, -active, -expanded,
// -visible or -toggled.
const STATE_CLASS = /^(?:is-|has-)?(?:open|opened|active|expanded|show|shown|visible|toggled(?:-on)?|focus|selected)$|-(?:open|opened|active|expanded|visible|toggled)$/i;
// [aria-expanded="true"], [aria-hidden="false"], [aria-selected], [aria-pressed], [open] on
// details and dialogs, and the data-* flags toggle scripts set.
const STATE_ATTRIBUTE = /^(?:aria-(?:expanded|hidden|selected|pressed|checked)|open|data-(?:open|state|expanded|active))$/i;

const isStateNode = (node) => (node.type === 'ClassSelector' && STATE_CLASS.test(node.name))
  || (node.type === 'AttributeSelector' && STATE_ATTRIBUTE.test(node.name.name));
const isPseudo = (node) => node.type === 'PseudoClassSelector' || node.type === 'PseudoElementSelector';

// The base of one complex selector (a csstree Selector), or null when it holds no state token.
function baseOf(selector) {
  const nodes = selector.children.toArray();
  if (!nodes.some(isStateNode)) return null;
  let out = '';
  let compound = '';
  const close = () => {
    out += compound || '*';
    compound = '';
  };
  for (const node of nodes) {
    if (node.type === 'Combinator') {
      close();
      out += node.name === ' ' ? ' ' : ` ${node.name} `;
    } else if (!isStateNode(node) && !isPseudo(node)) compound += csstree.generate(node);
  }
  close();
  return out;
}

// The bases of every state selector in a rule's prelude (a csstree SelectorList); [] when the
// rule styles no state, or its prelude did not parse.
export function stateBases(prelude) {
  if (prelude?.type !== 'SelectorList') return [];
  return [...new Set(prelude.children.toArray().map(baseOf).filter(Boolean))];
}

// Every style rule of a stylesheet that styles a state, as { start, end, bases } over its text.
export function stateRules(text) {
  let ast;
  try {
    ast = csstree.parse(text, { positions: true, onParseError: () => {} });
  } catch {
    return [];
  }
  const rules = [];
  csstree.walk(ast, {
    visit: 'Rule',
    enter(node) {
      if (!node.loc) return;
      const bases = stateBases(node.prelude);
      if (bases.length) rules.push({ start: node.loc.start.offset, end: node.loc.end.offset, bases });
    },
  });
  return rules;
}
