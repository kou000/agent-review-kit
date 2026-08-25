// Sync the 'collapsed' class on a file box and update its collapse-btn visuals.
// Called by the chevron click handler and by viewed-state toggling so both
// code paths stay in sync without duplicating the button update logic.
export function setCollapsed(box, on) {
  box.classList.toggle('collapsed', on);
  const btn = box.querySelector('.collapse-btn');
  if (!btn) return;
  btn.textContent = on ? '▸' : '▾';
  btn.title = on ? '展開する' : '折りたたむ';
  btn.setAttribute('aria-expanded', on ? 'false' : 'true');
}

// Create a collapse-toggle chevron button, wire its click handler, insert it
// at the front of `header`, and return it. Shared by renderDiff (interactive
// boxes) and renderReadOnlyFiles (read-only boxes) so they get identical
// collapse affordances.
export function appendCollapseToggle(header, box) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'collapse-btn';
  btn.textContent = '▾';
  btn.title = '折りたたむ';
  btn.setAttribute('aria-label', 'このファイルの表示を折りたたむ');
  btn.setAttribute('aria-expanded', 'true');
  btn.addEventListener('click', function () {
    setCollapsed(box, !box.classList.contains('collapsed'));
  });
  header.insertBefore(btn, header.firstChild);
  return btn;
}
