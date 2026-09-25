/** Pointer/keyboard selection for the positioned PDF translation layer. */
export function createPdfEditor({ container, onChange = () => {} }) {
  const doc = container.ownerDocument, selected = new Set(), abort = new AbortController();
  let available = false, active = false, drag = null, marquee = null;
  const nodes = () => [...container.querySelectorAll('.ezr-pdf-text')];
  const state = () => ({ active, available, selected:[...selected] });
  function cancelDrag() {
    const pointer = drag?.pointer; drag = null; marquee?.remove(); marquee = null;
    if (pointer !== undefined && container.hasPointerCapture?.(pointer)) container.releasePointerCapture(pointer);
  }
  function refresh() {
    for (const node of nodes()) {
      const chosen = active && selected.has(node.dataset.box);
      node.classList.toggle('ezr-pdf-text-selected', chosen);
      if (active) {
        node.tabIndex = 0; node.setAttribute('role','button'); node.setAttribute('aria-pressed',String(chosen));
        node.setAttribute('aria-label','选择译文文本框：' + node.dataset.fullText.slice(0,80));
      } else {
        for (const name of ['tabindex','role','aria-pressed','aria-label']) node.removeAttribute(name);
      }
    }
    onChange(state());
  }
  function setActive(value) {
    active = !!value && available; cancelDrag(); selected.clear();
    container.classList.toggle('ezr-pdf-editing',active);
    if (active) doc.getSelection()?.removeAllRanges();
    refresh(); return active;
  }
  function setAvailable(value) {
    value = !!value;
    if (available === value) return;
    available = value;
    if (!value) setActive(false); else refresh();
  }
  const hit = rect => nodes().filter(node => {
    const bounds = node.getBoundingClientRect(), clip = container.getBoundingClientRect();
    return bounds.right >= rect.left && bounds.left <= rect.right && bounds.bottom >= rect.top && bounds.top <= rect.bottom
      && bounds.bottom >= clip.top && bounds.top <= clip.bottom && bounds.right >= clip.left && bounds.left <= clip.right;
  }).map(node => node.dataset.box);
  function choose(ids, additive, toggle = false) {
    if (!additive) selected.clear();
    for (const id of ids) { if (toggle && selected.has(id)) selected.delete(id); else selected.add(id); }
    refresh();
  }
  function down(event) {
    if (!active || event.button !== 0) return;
    event.preventDefault(); event.stopImmediatePropagation(); doc.getSelection()?.removeAllRanges(); cancelDrag();
    drag = { x:event.clientX, y:event.clientY, pointer:event.pointerId, moved:false,
      id:event.target.closest('.ezr-pdf-text')?.dataset.box, additive:event.ctrlKey || event.metaKey || event.shiftKey };
    container.setPointerCapture(event.pointerId);
  }
  function move(event) {
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (Math.hypot(event.clientX - drag.x,event.clientY - drag.y) < 4 && !drag.moved) return;
    drag.moved = true;
    drag.rect = { left:Math.min(drag.x,event.clientX), top:Math.min(drag.y,event.clientY), right:Math.max(drag.x,event.clientX), bottom:Math.max(drag.y,event.clientY) };
    if (!marquee) { marquee = doc.createElement('div'); marquee.className = 'ezr-pdf-marquee'; marquee.setAttribute('data-ezr-ui',''); doc.body.appendChild(marquee); }
    const r = drag.rect;
    Object.assign(marquee.style,{ left:r.left + 'px',top:r.top + 'px',width:r.right-r.left + 'px',height:r.bottom-r.top + 'px' });
  }
  function up(event) {
    if (!drag || drag.pointer !== event.pointerId) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const previous = drag; cancelDrag();
    choose(previous.moved ? hit(previous.rect) : previous.id ? [previous.id] : [], previous.additive, !previous.moved && previous.additive);
  }
  function keydown(event) {
    if (!active) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setActive(false); return; }
    const node = event.target.closest?.('.ezr-pdf-text');
    if (node && container.contains(node) && ['Enter',' '].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      choose([node.dataset.box],event.ctrlKey || event.metaKey || event.shiftKey,true);
    }
  }
  const opts = { capture:true,signal:abort.signal };
  container.addEventListener('pointerdown',down,opts);
  container.addEventListener('pointermove',move,opts);
  container.addEventListener('pointerup',up,opts);
  container.addEventListener('pointercancel',cancelDrag,opts);
  container.addEventListener('lostpointercapture',cancelDrag,opts);
  container.addEventListener('scroll',cancelDrag,{ passive:true,signal:abort.signal });
  doc.defaultView.addEventListener('keydown',keydown,opts);
  doc.defaultView.addEventListener('blur',cancelDrag,{ signal:abort.signal });
  doc.defaultView.addEventListener('resize',cancelDrag,{ signal:abort.signal });
  return { setActive, setAvailable, refresh, cancelDrag, get state() { return state(); },
    clear() { cancelDrag(); selected.clear(); refresh(); },
    destroy() { setActive(false); abort.abort(); } };
}