import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTextBoxes, findTextBox } from '../src/documents/layout.js';
import { patchPdfjsTextFilter } from '../tools/pdfjs-text-filter.js';
import { readFile } from 'node:fs/promises';

test('overlapping body and subscript boxes match the actual glyph baseline regardless of box order', () => {
  const content = { styles:{ f:{ ascent:.8, descent:.2 } }, items:[
    { str:'x', transform:[18,0,0,18,40,100], width:9, fontName:'f' },
    { str:'s', transform:[10,0,0,10,49,96], width:5, fontName:'f' },
    { str:'(t)', transform:[18,0,0,18,54,100], width:18, fontName:'f' },
  ] };
  const boxes = extractTextBoxes(content,{transform:[1,0,0,-1,0,200]});
  assert.equal(boxes.length,2);
  assert.equal(findTextBox(boxes,49,104).text,'s');
  assert.equal(findTextBox([...boxes].reverse(),49,104).text,'s');
  assert.equal(findTextBox(boxes,58,100).text,'x (t)');
  assert.equal(findTextBox(boxes,200,100),undefined);
});

test('matching includes untranslated boxes so a neighboring translated box cannot swallow their glyphs', () => {
  const boxes = [
    {id:'body',angle:0,items:[{x:0,baseline:30,width:100,fontSize:20}]},
    {id:'subscript',angle:0,items:[{x:20,baseline:34,width:8,fontSize:10}]},
  ];
  assert.equal(findTextBox(boxes,22,34).id,'subscript');
});

test('rotated glyph matching uses the text box coordinate system', () => {
  const box = {angle:Math.PI/2,items:[{x:10,baseline:20,width:30,fontSize:12}]};
  assert.equal(findTextBox([box],-20,15),box);
});

test('PDF.js glyph hook can be reapplied to the pinned vendor without duplicate instrumentation', async () => {
  const source = await readFile(new URL('../src/vendor/pdfjs/pdf.mjs',import.meta.url),'utf8');
  assert.equal(patchPdfjsTextFilter(source),source);
  assert.equal(source.split('const ezrGlyphVisible =').length,2);
});
