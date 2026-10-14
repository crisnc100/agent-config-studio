/**
 * Case-insensitive literal search of one text: the first `max` matching
 * lines (1-based, trimmed, cut to `width`) and how many lines matched in all.
 * The one matcher /api/search and Assist's @@FIND share.
 */
export function matchLines(text, query, { max = 4, width = 220 } = {}) {
  const needle = query.toLowerCase();
  const lines = text.split('\n');
  const matches = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(needle)) continue;
    total++;
    if (matches.length < max) matches.push({ line: i + 1, text: lines[i].trim().slice(0, width) });
  }
  return { matches, total };
}
