// The control panel, generated from parameter tables.
// onInput fires while dragging (draft quality), onChange when released.

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const k in props) { if (k === 'class') e.className = props[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), props[k]); else if (k === 'text') e.textContent = props[k]; else e.setAttribute(k, props[k]); }
  for (const k of kids) if (k) e.append(k);
  return e;
};

const fmt = (d, v) => {
  if (d.unit === 'm') return v >= 0.1 ? `${(v * 100).toFixed(0)} cm` : `${(v * 1000).toFixed(1).replace(/\.0$/, '')} mm`;
  if (d.step >= 1) return String(v);
  return (+v).toFixed(2);
};

export function section(title, open = true) {
  const body = el('div', { class: 'sec-body' });
  const sec = el('details', { class: 'sec' }, el('summary', { text: title }), body);
  if (open) sec.setAttribute('open', '');
  return { sec, body };
}

// Build controls for defs into `into`, bound to `obj`.
export function controls(into, defs, obj, onInput, onChange) {
  const refresh = [];
  for (const d of defs) {
    const row = el('label', { class: 'row' });
    row.append(el('span', { class: 'lab', text: d.label, title: d.hint || '' }));
    if (d.options) {
      const sel = el('select', { onchange: () => { obj[d.key] = sel.value; onChange(d.key); } });
      for (const o of d.options) { const [v, t] = Array.isArray(o) ? o : [o, o]; sel.append(el('option', { value: v, text: t })); }
      sel.value = obj[d.key]; row.append(sel);
      refresh.push(() => { sel.value = obj[d.key]; });
    } else if (d.type === 'color') {
      const ci = el('input', { type: 'color', value: obj[d.key] });
      ci.addEventListener('input', () => { obj[d.key] = ci.value; onInput(d.key); });
      ci.addEventListener('change', () => { obj[d.key] = ci.value; onChange(d.key); });
      row.append(ci); row.classList.add('check');
      refresh.push(() => { ci.value = obj[d.key]; });
    } else if (d.type === 'bool') {
      const cb = el('input', { type: 'checkbox', onchange: () => { obj[d.key] = cb.checked; onChange(d.key); } });
      cb.checked = !!obj[d.key]; row.append(cb); row.classList.add('check');
      refresh.push(() => { cb.checked = !!obj[d.key]; });
    } else {
      const val = el('span', { class: 'val', text: fmt(d, obj[d.key]) });
      const rg = el('input', { type: 'range', min: d.min, max: d.max, step: d.step, value: obj[d.key] });
      rg.addEventListener('input', () => { obj[d.key] = +rg.value; val.textContent = fmt(d, obj[d.key]); onInput(d.key); });
      rg.addEventListener('change', () => { onChange(d.key); });
      row.append(rg, val);
      refresh.push(() => { rg.value = obj[d.key]; val.textContent = fmt(d, obj[d.key]); });
    }
    into.append(row);
  }
  return () => refresh.forEach((f) => f());
}

export function button(text, onclick, cls = '') { return el('button', { class: cls, onclick, text }); }
export { el };
