# The optional component pass

Off by default. Run it only when the intake said "components", the person asked for it, or the
run was started with `--components`. It happens after `visual-all` passes and before
`prelaunch`, and it changes how the site is built, never what it serves.

## What it does

Repeated content blocks (cards, calls to action, testimonials, galleries, team grids, pricing
rows) that appear as identical markup with different text or images become Astro components in
`src/components/blocks/`, each with its markup copied from the capture and its own styles moved
out of `src/styles/site.css` into a scoped `<style>` only when the rules are used by that block
alone. The layouts and the header, navigation and footer are already components; this pass does
not touch them.

## How

1. Find candidates from the captured markup: the same element structure and class list in three
   or more places (`grep` over `src/content/pages/`, or a parse5 walk). List each candidate with
   its count and pages before changing anything.
2. One block type at a time: write the component, replace each occurrence in the content files
   with it (by a script, passing the captured text and attributes as props, never retyped), and
   rebuild.
3. After each block type: `npm run build`, `npm run verify` (text, links, media, SEO must not
   move) and the visual review on every page that holds the block (shoot, diff against
   `capture/screens/live-all`). Every pair must still pass. A block whose pixels or text move is
   reverted, not tuned.
4. If your agent can run subagents, give each block type to one implementer, with the absolute
   paths of the component to write and the pages it replaces.

## The commit

All of the pass is **one separate commit** on `astro-rebuild`, `refactor: content block components`,
made only when every gate and every diff passes, so the person can drop it with one revert. Record
`S set phases.components.result '{"blocks":[…],"pages":n}'` and say in the PR which blocks were
extracted and that the commit can be reverted on its own.

## What it never does

No new design, no merged variants that looked "almost the same", no props that change output, no
CMS wiring. A block that differs between pages in anything but content stays as captured markup.
