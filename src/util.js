module.exports.forEachNode = (node, f) => {
  f(node);
  for (const child of node.children) {
    module.exports.forEachNode(child, f);
  }
}

// Apply edits and hoisted declarations to sourceCode, returning the new string.
module.exports.applyEdits = (sourceCode, hoisted, edits) => {
  // Sort edits descending by start so slicing doesn't invalidate positions.
  const sortedEdits = [...edits].sort((a, b) => b.start - a.start);

  let result = sourceCode;
  for (const { start, end, replacement } of sortedEdits) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  // Apply hoisted text: sort descending by byte offset and insert.
  // Because edits above have already shifted the string, we need to track
  // the offset delta. Simpler: collect hoisted insertions as edits with
  // start === end (pure insertions) before applying any edits.
  // So instead: redo — collect ALL edits (hoisted as zero-width insertions)
  // then sort and apply together.
  // But hoisted is keyed by original byte offsets, same as edits, so we can
  // merge them into one sorted list where hoisted items have replacement=text
  // and start=end=beforeByteOffset.

  // Redo cleanly: merge hoisted + edits into one list, apply in reverse order.
  const allEdits = [
    ...edits,
    ...hoisted.map(h => ({ start: h.beforeByteOffset, end: h.beforeByteOffset, replacement: h.text })),
  ].sort((a, b) => b.start - a.start);

  let out = sourceCode;
  for (const { start, end, replacement } of allEdits) {
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}