const REGION = 'main,article,[role="main"],section,div,table';
const AUXILIARY = 'nav,aside,footer,[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"]';

/** Put the dominant content region first without changing any text runs or their identity. */
export function prioritizeWebsiteGroups(groups, doc) {
  const root = doc.body;
  const width = doc.documentElement.clientWidth || doc.defaultView.innerWidth;
  const height = doc.documentElement.clientHeight || doc.defaultView.innerHeight;
  if (!root || !width || !height || groups.length < 2) return groups;

  const candidates = new Map(), metadata = new Map(), eligible = new Set();
  const describe = element => {
    if (!metadata.has(element)) metadata.set(element, {
      region: element.matches(REGION), auxiliary: !!element.closest(AUXILIARY),
    });
    return metadata.get(element);
  };
  groups.forEach((group, index) => {
    if (!root.contains(group.block) || describe(group.block).auxiliary) return;
    eligible.add(group);
    const chars = group.source.length;
    const links = group.runs.reduce((length, run) => length + (run.owner.closest('a') ? run.source.length : 0), 0);
    for (let element = group.block; element && element !== root; element = element.parentElement) {
      if (!describe(element).region) continue;
      let stats = candidates.get(element);
      if (!stats) {
        stats = { element, first: index, count: 0, chars: 0, links: 0 };
        candidates.set(element, stats);
      }
      stats.count++; stats.chars += chars; stats.links += links;
    }
  });

  let best = null, bestScore = 0;
  const coverage = new Set();
  for (const stats of candidates.values()) {
    const { element, first, count, chars, links } = stats;
    const rect = element.getBoundingClientRect();
    // Cap page-length height so a narrow, very long column cannot win on height alone.
    const area = Math.min(rect.width, width) * Math.min(rect.height, height * 2);
    if (!(rect.width > 0 && rect.height > 0 && area > 0)) continue;
    // Descendants were inserted first. Ignore outer layout shells containing exactly
    // the same eligible groups, otherwise a full-page wrapper would always win.
    const key = first + ':' + count;
    if (coverage.has(key)) continue;
    coverage.add(key);
    const semantic = element.matches('main,[role="main"]') ? 1.3 : element.matches('article') ? 1.2 : 1;
    const linkPenalty = 1 - .9 * Math.min(1, links / Math.max(1, chars));
    const score = area * Math.log1p(chars) * semantic * linkPenalty;
    if (score > bestScore) { best = element; bestScore = score; }
  }
  if (!best) return groups;
  const first = [], rest = [];
  for (const group of groups) (eligible.has(group) && best.contains(group.block) ? first : rest).push(group);
  return [...first, ...rest];
}
