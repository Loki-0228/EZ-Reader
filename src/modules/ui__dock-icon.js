/** Shared dock-direction glyph; target is the edge the button moves its toolbar to. The button owns its accessible label. */
export function dockIcon(doc, target) {
  const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 20 20'); icon.setAttribute('width', '18'); icon.setAttribute('height', '18');
  icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', target === 'top' ? 'M4 4h12M10 16V7M6.5 10.5L10 7l3.5 3.5' : 'M4 16h12M10 4v9M6.5 9.5L10 13l3.5-3.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
  icon.appendChild(path); return icon;
}
