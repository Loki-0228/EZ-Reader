/** Replace a compact settings action with the shared gear icon. */
export function setSettingsIcon(button, label = '设置', doc = button.ownerDocument) {
  button.replaceChildren();
  button.setAttribute('aria-label', label);
  button.title = label;
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const gear = doc.createElementNS(svg.namespaceURI, 'path');
  const toothProfile = [
    [-13, 7.15], [-9, 7.15], [-7.5, 8.1], [7.5, 8.1],
    [9, 7.15], [13, 7.15], [22.5, 6.9],
  ];
  const outline = [];
  for (let tooth = 0; tooth < 8; tooth += 1) {
    for (const [offset, radius] of toothProfile) {
      const angle = ((tooth * 45 + offset - 90) * Math.PI) / 180;
      const x = (12 + Math.cos(angle) * radius).toFixed(2);
      const y = (12 + Math.sin(angle) * radius).toFixed(2);
      outline.push(`${outline.length ? 'L' : 'M'}${x} ${y}`);
    }
  }
  gear.setAttribute('d', `${outline.join(' ')} Z`);
  const hub = doc.createElementNS(svg.namespaceURI, 'circle');
  hub.setAttribute('cx', '12'); hub.setAttribute('cy', '12'); hub.setAttribute('r', '5');
  const center = doc.createElementNS(svg.namespaceURI, 'circle');
  center.setAttribute('cx', '12'); center.setAttribute('cy', '12'); center.setAttribute('r', '2.1');
  svg.append(gear, hub, center);
  button.appendChild(svg);
  return button;
}
