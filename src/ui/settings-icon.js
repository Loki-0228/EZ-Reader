/** Replace a compact settings action with the shared gear icon. */
export function setSettingsIcon(button, label = '设置', doc = button.ownerDocument) {
  button.replaceChildren();
  button.setAttribute('aria-label', label);
  button.title = label;
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const spokes = doc.createElementNS(svg.namespaceURI, 'path');
  spokes.setAttribute('d', 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.28 5.28l2.12 2.12m9.2 9.2 2.12 2.12m0-13.44-2.12 2.12m-9.2 9.2-2.12 2.12');
  const hub = doc.createElementNS(svg.namespaceURI, 'circle');
  hub.setAttribute('cx', '12'); hub.setAttribute('cy', '12'); hub.setAttribute('r', '6.25');
  const center = doc.createElementNS(svg.namespaceURI, 'circle');
  center.setAttribute('cx', '12'); center.setAttribute('cy', '12'); center.setAttribute('r', '2.1');
  svg.append(spokes, hub, center);
  button.appendChild(svg);
  return button;
}
