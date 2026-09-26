/** Reapply the local text-paint hook when updating pinned PDF.js. */
export function patchPdfjsTextFilter(source) {
  if (source.includes('ezrShowText(opIdx, glyphs)')) return patchGlyphFilter(source);
  const replacements = [
    ['  showText(opIdx, glyphs) {', `  showText(opIdx, glyphs) {
    // EZ-Reader: suppress painting only; retain text advances and graphics state.
    const visible = this.contentVisible;
    if (this.textFilter && visible) {
      const current = this.current;
      const transform = getCurrentTransform(this.ctx);
      const matrix = current.textMatrix ? Util.transform(transform, current.textMatrix) : transform;
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
  return patchGlyphFilter(source);
}

function patchGlyphFilter(source) {
  if (source.includes('const ezrGlyphVisible =')) return source;
  const replacements = [
    ['if (this.textFilter && visible) {', 'if (this.textFilter && visible && (this.current.font.isType3Font || this.current.font.isInvalidPDFjsFont)) {'],
    ['      if (this.contentVisible && (glyph.isInFont || font.missingFile)) {', `      // EZ-Reader: one PDF text operation can span several extracted text boxes.
      const ezrPoint = [scaledX, scaledY];
      Util.applyTransform(ezrPoint, getCurrentTransform(ctx));
      const ezrGlyphVisible = this.contentVisible && (!this.textFilter || this.textFilter({
        x:ezrPoint[0], y:ezrPoint[1], text:glyph.unicode || "",
        color:current.fillColor, fontName:font.name
      }) !== false);
      if (ezrGlyphVisible && (glyph.isInFont || font.missingFile)) {`],
  ];
  for (const [before,after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('PDF.js glyph filter patch no longer matches: ' + before);
    source = source.replace(before,after);
  }
  return source;
}
