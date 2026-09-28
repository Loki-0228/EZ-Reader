/** Shared close glyph; the button owns its accessible label. */
export function closeIcon(doc) {
  const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 20 20'); icon.setAttribute('width', '18'); icon.setAttribute('height', '18');
  icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 5l10 10M15 5L5 15'); path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.6'); path.setAttribute('stroke-linecap', 'round');
  icon.appendChild(path); return icon;
}
