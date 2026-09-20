import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prioritizeWebsiteGroups } from '../src/dom/translation-order.js';

function fixture() {
  const element = (tag, parentElement, width = 800, height = 500, role = '') => ({
    tag, parentElement, reads: 0,
    matches(selector) { return selector.split(',').some(item => item === tag || item === '[role="' + role + '"]'); },
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; },
    contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; },
    getBoundingClientRect() { this.reads++; return { width, height }; },
  });
  const body = element('body', null, 1200, 5000);
  const doc = { body, documentElement: {clientWidth:1200, clientHeight:800}, defaultView:{} };
  const group = (block, source) => ({block, source, runs:[{owner:block, source}], chunks:[source]});
  return { element, body, doc, group };
}

test('largest article precedes navigation, sidebar and smaller articles without dropping or changing groups', () => {
  const {element, body, doc, group} = fixture();
  const wrapper = element('div', body, 1200, 5000);
  const nav = element('nav', wrapper, 1200, 300), aside = element('aside', wrapper, 1000, 5000);
  const small = element('article', aside, 900, 4000), main = element('article', wrapper, 850, 1400);
  const groups = [group(nav,'Navigation'), group(small,'Related stories '.repeat(1000)),
    group(element('h1', main),'Main heading'), group(element('p', main),'Body text '.repeat(60)),
    group(element('p', main),'Second paragraph'), group(element('footer', wrapper),'Copyright')];
  const before = [...groups];
  assert.deepEqual(prioritizeWebsiteGroups(groups,doc), [groups[2],groups[3],groups[4],groups[0],groups[1],groups[5]]);
  assert.deepEqual(groups, before);
  assert.ok(main.reads <= 1 && wrapper.reads <= 1);
});

test('generic div layout uses occupied area and content instead of the first small article or tall link list', () => {
  const {element, body, doc, group} = fixture();
  const small = element('article', body, 280, 150);
  const links = element('div', body, 220, 9000), link = element('a', links);
  const large = element('div', body, 850, 1100);
  const groups = [group(small,'Short introductory card.'), group(link,'Related links '.repeat(200)),
    group(element('h1',large),'Largest content heading'), group(element('p',large),'Primary content. '.repeat(100))];
  assert.deepEqual(prioritizeWebsiteGroups(groups,doc), [groups[2],groups[3],groups[0],groups[1]]);
});

test('equivalent nested wrappers cannot overtake the main region and its title', () => {
  const {element, body, doc, group} = fixture();
  const wrapper = element('div', body, 1200, 5000), inner = element('div',wrapper,1100,4000);
  const nav = element('nav', inner, 1100, 100), main = element('div',inner,800,1000,'main');
  const groups = [group(nav,'Navigation first in DOM'), group(element('h1',main),'Heading'),
    group(element('div',main,800,800),'Body '.repeat(100))];
  assert.deepEqual(prioritizeWebsiteGroups(groups,doc), [groups[1],groups[2],groups[0]]);
});

test('largest of multiple semantic regions wins; duplicate runs retain order and cache keys', () => {
  const {element, body, doc, group} = fixture();
  const small = element('article', body, 250, 180), large = element('article', body, 850, 1100);
  const p = element('p',large);
  const groups = [group(small,'Related preview '.repeat(10)), group(p,'First body run '.repeat(10)), group(p,'First body run '.repeat(10)), group(p,'Last run')];
  const result = prioritizeWebsiteGroups(groups,doc);
  assert.deepEqual(result,[groups[1],groups[2],groups[3],groups[0]]);
  assert.equal(new Set(result.flatMap(item=>item.chunks)).size,3);
  assert.equal(large.reads,1);
});

test('missing layout or a page with no content region safely keeps its original queue', () => {
  const {element, body, doc, group} = fixture();
  const groups = [group(body,'Page text'), group(element('div',body,0,0),'Unmeasurable region')];
  assert.equal(prioritizeWebsiteGroups(groups,doc),groups);
  assert.equal(prioritizeWebsiteGroups([],doc).length,0);
});
