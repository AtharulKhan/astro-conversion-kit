# Dependencies

The kit has five runtime dependencies, each pinned to an exact version in `package.json`. Every
other job (HTTP, argument parsing, file work, the test runner) uses Node's standard library.
Scripts are plain ES modules: no framework, no bundler, no build step. The same five are copied
into each converted site's `package.json` so its gates run on their own after the kit is gone.

A new dependency needs a section here that says what it does, why the standard library cannot,
and what was considered instead.

## parse5

Parses HTML the way a browser does, following the WHATWG specification, including broken markup
that real sites are full of. The gates and the capture use it to read titles, meta tags, canonicals,
JSON-LD, headings, links, images and the visible main text from saved HTML and from the build.
Regular expressions get this wrong on the first unclosed tag or comment that contains markup.
parse5's only dependency is its entity decoder, and it does no network or file access.

## playwright

Drives a real Chromium for everything that needs a rendered page: live and new screenshots at 390,
768 and 1440 px, CSS coverage for pruning, computed-style comparison, lazy-loaded images, and the
browser tier of the launch audit. A static HTML parser cannot tell what a page looks like or which
CSS rules apply. Only Chromium is used, installed with `npx playwright install chromium`. Scripts
that do not need a browser never load it.

## pixelmatch

Compares two screenshots pixel by pixel and counts the pixels that differ, with a perceptual colour
threshold and anti-aliasing detection, and writes a diff image. It is small and fast, and its
only dependency is pngjs, which the kit needs anyway. The visual review passes a pair at 0.5 %
differing pixels or fewer, with a threshold of 0.1 and anti-aliased pixels not counted.

## pngjs

Reads and writes PNG files in plain JavaScript, so pixelmatch has raw pixels to compare and the
diff image can be saved. Playwright writes PNG screenshots; pngjs decodes them. It needs no native
build step, which keeps installation working on any machine Node runs on. Image resizing or
optimisation libraries (such as sharp) were left out: the kit never changes an image, it only
compares and copies.

## css-tree

Parses CSS into a tree, walks it, and prints it back. Pruning uses it to remove the rules that
browser coverage shows no page used at any width, without disturbing at-rules, media queries or
the rules that stay, and the capture uses it to find the `url()` references that are part of the
media and font set. Splitting a stylesheet on braces breaks on strings, comments and nested
at-rules. css-tree has two small dependencies and no native code.
