// The srcset parser shared by the capture and the links gate. No side effects on import.

// The candidate URLs of a srcset, as the HTML rules read it: skip spaces and commas, take a run
// of non-spaces as the URL (trailing commas end it, with no descriptors), then skip descriptors up
// to the next comma outside parentheses. A URL may itself contain commas (w_300,h_200).
export function srcsetUrls(srcset) {
  const text = String(srcset ?? '');
  const space = (c) => /\s/.test(c);
  const urls = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (space(text[i]) || text[i] === ',')) i += 1;
    const start = i;
    while (i < text.length && !space(text[i])) i += 1;
    let url = text.slice(start, i);
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      for (let depth = 0; i < text.length; i += 1) {
        const c = text[i];
        if (c === '(') depth += 1;
        else if (c === ')') depth = Math.max(0, depth - 1);
        else if (c === ',' && depth === 0) break;
      }
    }
    if (url) urls.push(url);
  }
  return urls;
}
