/** PDF coordinates, not DOM visibility or paragraph length, determine text boxes. */
export function transformPoint(matrix, x, y) {
  return { x:matrix[0] * x + matrix[2] * y + matrix[4], y:matrix[1] * x + matrix[3] * y + matrix[5] };
}

export function extractTextBoxes(content, viewport) {
  const items = [];
  for (const [index, item] of content.items.entries()) {
    if (typeof item.str !== 'string' || !item.str.trim() || !item.transform?.every(Number.isFinite)) continue;
    const t = item.transform, v = viewport.transform, origin = transformPoint(v, t[4], t[5]);
    const style = content.styles?.[item.fontName] || {};
    const coordinateScale = Math.hypot(v[0],v[1]);
    let angle = Math.atan2(v[1] * t[0] + v[3] * t[1], v[0] * t[0] + v[2] * t[1]);
    if (style.vertical) angle += Math.PI / 2;
    const fontSize = Math.max(.1, Math.hypot(t[2], t[3]) * coordinateScale);
    const ascent = Number.isFinite(style.ascent) ? style.ascent : .85;
    const descent = Number.isFinite(style.descent) ? Math.abs(style.descent) : .2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const x = origin.x * cos + origin.y * sin, baseline = -origin.x * sin + origin.y * cos;
    items.push({ index, text:item.str, x, y:baseline - ascent * fontSize, baseline, angle,
      width:Math.max(.1, (style.vertical ? item.height : item.width) * coordinateScale),
      height:Math.max(1, ascent + descent) * fontSize, fontSize, fontName:item.fontName,
      bold:/bold|black|heavy/i.test(style.fontFamily || ''), dir:item.dir || 'ltr' });
  }
  // Sort geometrically: slide generators frequently interleave different text boxes in the stream.
  items.sort((a,b) => Math.round(a.angle * 1000) - Math.round(b.angle * 1000) || a.baseline - b.baseline || a.x - b.x);
  const lines = [];
  for (const item of items) {
    const line = lines.findLast(line => Math.abs(line.angle - item.angle) < .01
      && Math.abs(line.baseline - item.baseline) < Math.min(line.fontSize, item.fontSize) * .3
      && item.x >= line.x - .5 && item.x - (line.x + line.width) < Math.max(line.fontSize, item.fontSize) * 1.3);
    if (!line) { lines.push({ ...item, items:[item] }); continue; }
    const gap = item.x - (line.x + line.width);
    const space = gap > Math.min(line.fontSize,item.fontSize) * .12 && !/\s$/u.test(line.text) && !/^\s/u.test(item.text);
    line.text += (space ? ' ' : '') + item.text;
    line.width = Math.max(line.x + line.width, item.x + item.width) - line.x;
    const bottom = Math.max(line.y + line.height, item.y + item.height);
    line.y = Math.min(line.y,item.y); line.height = bottom - line.y;
    line.fontSize = Math.max(line.fontSize,item.fontSize); line.items.push(item);
  }
  const boxes = [];
  for (const line of lines) {
    const box = boxes.findLast(box => Math.abs(box.angle - line.angle) < .01
      && Math.abs(box.fontSize - line.fontSize) < line.fontSize * .2
      && line.baseline - box.lastBaseline > line.fontSize * .65
      && line.y - (box.y + box.height) < line.fontSize * .65
      && line.y >= box.y
      && (Math.abs(box.x - line.x) < line.fontSize * .6
        || Math.abs(box.x + box.width / 2 - line.x - line.width / 2) < line.fontSize * .35));
    if (!box) { boxes.push({ ...line, items:[...line.items], lastBaseline:line.baseline, lineCount:1 }); continue; }
    const right = Math.max(box.x + box.width,line.x + line.width);
    box.x = Math.min(box.x,line.x); box.width = right - box.x;
    box.height = Math.max(box.y + box.height,line.y + line.height) - box.y;
    box.text += '\n' + line.text; box.lastBaseline = line.baseline; box.lineCount++;
    box.items.push(...line.items);
  }
  return boxes.map((box,index) => {
    const cos = Math.cos(box.angle), sin = Math.sin(box.angle);
    return { ...box, id:String(index), left:box.x * cos - box.y * sin, top:box.x * sin + box.y * cos,
      lineHeight:Math.max(1.05, box.lineCount > 1 ? (box.lastBaseline - box.baseline) / (box.lineCount - 1) / box.fontSize : 1.2) };
  });
}

export function containsBaseline(box, x, y) {
  const cos = Math.cos(box.angle), sin = Math.sin(box.angle), slack = box.fontSize * .35;
  const px = x * cos + y * sin, py = -x * sin + y * cos;
  return px >= box.x - slack && px <= box.x + box.width + slack && py >= box.y - slack && py <= box.y + box.height + slack;
}

/** Overlapping formulas need the nearest glyph baseline, not the first enclosing paragraph. */
export function findTextBox(boxes, x, y) {
  let best, distance = Infinity;
  for (const box of boxes) {
    const cos = Math.cos(box.angle), sin = Math.sin(box.angle);
    const px = x * cos + y * sin, py = -x * sin + y * cos;
    for (const item of box.items) {
      const dx = Math.max(item.x - px, 0, px - item.x - item.width);
      const dy = Math.abs(py - item.baseline);
      if (dx > item.fontSize * .35 || dy > item.fontSize * .35) continue;
      const score = Math.hypot(dx,dy) / item.fontSize;
      if (score < distance) { best = box; distance = score; }
    }
  }
  return best;
}

const graphemes = new Intl.Segmenter(undefined, { granularity:'grapheme' });
export function wrapText(text, width, measure) {
  const lines = [];
  for (const paragraph of String(text).replace(/\r\n?/g,'\n').split('\n')) {
    const chars = [...graphemes.segment(paragraph)].map(part => part.segment);
    if (!chars.length) { lines.push(''); continue; }
    let start = 0;
    while (start < chars.length) {
      let end = start, lastBreak = start;
      while (end < chars.length && measure(chars.slice(start,end + 1).join('')) <= width) {
        end++;
        if (/\s|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(chars[end - 1])) lastBreak = end;
      }
      if (end === start) end++;
      else if (end < chars.length && lastBreak > start) end = lastBreak;
      lines.push(chars.slice(start,end).join('')); start = end;
    }
  }
  return lines;
}

/** Wrap text inside the box width at a fixed font size. Leading follows the measured glyph ink. */
function layoutAt(text, box, fontSize, leading, measureAtSize) {
  const metrics = value => measureAtSize(value,fontSize);
  const width = value => { const measured = metrics(value); return typeof measured === 'number' ? measured : measured.width; };
  const lines = wrapText(text,box.width,width);
  const inkHeight = lines.reduce((height,line) => Math.max(height,metrics(line)?.height || 0),0);
  const lineHeight = Math.max(leading,inkHeight / fontSize + .04);
  const height = lines.length * fontSize * lineHeight;
  return { text, lines, fontSize, lineHeight, height,
    fits:height <= box.height + .001 && lines.every(line => width(line) <= box.width + .001) };
}

/** User-chosen font size: rewrap inside the original width and adapt leading to the glyphs.
 * Never shrinks or truncates — a box that cannot hold the text reports fits=false and overflows. */
export function layoutManual(text, box, fontSize, measureAtSize) {
  return layoutAt(text, box, fontSize, Math.max(1.05,box.lineHeight || 1.2), measureAtSize);
}

/** Never truncate, clamp or ellipsize. Tighten leading first, then binary-search font size. */
export function fitText(text, box, measureAtSize) {
  const layout = (fontSize, leading) => layoutAt(text, box, fontSize, leading, measureAtSize);
  const leading = Math.max(1.05,box.lineHeight || 1.2);
  const natural = layout(box.fontSize,leading);
  if (natural.fits) return natural;
  const tight = layout(box.fontSize,1.05);
  if (tight.fits) return tight;
  let low = 0, high = box.fontSize, best;
  for (let step = 0; step < 26; step++) {
    const middle = (low + high) / 2, candidate = layout(middle,1.05);
    if (candidate.fits) { best = candidate; low = middle; } else high = middle;
  }
  if (!best) throw new Error('文本框无法容纳完整译文，请调整源文档中的文本框后重试。');
  return best;
}
