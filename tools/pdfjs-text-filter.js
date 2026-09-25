/** Reapply the local text-paint hook when updating pinned PDF.js. */
export function patchPdfjsTextFilter(source) {
  if (source.includes('ezrShowText(opIdx, glyphs)')) return source;
  const replacements = [
    ['  showText(opIdx, glyphs) {', `  showText(opIdx, glyphs) {
    // EZ-Reader: suppress painting only; retain text advances and graphics state.
    const visible = this.contentVisible;
    if (this.textFilter && visible) {
      const current = this.current;
      const matrix = Util.transform(getCurrentTransform(this.ctx), current.textMatrix || IDENTITY_MATRIX);
      const point = [current.x, current.y + current.textRise];
      Util.applyTransform(point, matrix);
      this.contentVisible = this.textFilter({ x:point[0], y:point[1],
        text:glyphs.filter(glyph => typeof glyph !== "number").map(glyph => glyph.unicode || "").join(""),
        color:current.fillColor, fontName:current.font?.name }) !== false;
    }
    try { this.ezrShowText(opIdx, glyphs); }
    finally { this.contentVisible = visible; }
  }
  ezrShowText(opIdx, glyphs) {`],
    ['      ctx.fillText(joinedChars, 0, 0);', '      if (this.contentVisible) ctx.fillText(joinedChars, 0, 0);'],
    ['    recordOperations = false,\n    operationsFilter = null', '    recordOperations = false,\n    operationsFilter = null,\n    textFilter = null'],
    ['        transform,\n        background\n      },\n      objs:', '        transform,\n        background,\n        textFilter\n      },\n      objs:'],
    ['    this.gfx.beginDrawing({', '    this.gfx.textFilter = this.params.textFilter;\n    this.gfx.beginDrawing({'],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('PDF.js text filter patch no longer matches: ' + before);
    source = source.replace(before,after);
  }
  return source;
}
