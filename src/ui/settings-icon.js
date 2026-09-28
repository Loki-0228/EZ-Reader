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
  gear.setAttribute('d', 'M9.8 2.8h4.4l.52 2.18c.58.18 1.1.48 1.57.86l2.16-.62 2.2 3.82-1.62 1.56c.08.64.08 1.28 0 1.92l1.62 1.56-2.2 3.82-2.16-.62c-.47.38-.99.68-1.57.86l-.52 2.18H9.8l-.52-2.18a6.6 6.6 0 0 1-1.57-.86l-2.16.62-2.2-3.82 1.62-1.56a7.7 7.7 0 0 1 0-1.92L3.35 9.04l2.2-3.82 2.16.62c.47-.38.99-.68 1.57-.86L9.8 2.8z');
  const hub = doc.createElementNS(svg.namespaceURI, 'circle');
  hub.setAttribute('cx', '12'); hub.setAttribute('cy', '12'); hub.setAttribute('r', '6.25');
  const center = doc.createElementNS(svg.namespaceURI, 'circle');
  center.setAttribute('cx', '12'); center.setAttribute('cy', '12'); center.setAttribute('r', '2.1');
  svg.append(gear, hub, center);
  button.appendChild(svg);
  return button;
}
