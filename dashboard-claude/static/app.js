/* Clubhouse — golf warehouse dashboard frontend.
   No framework, no CDN. SVG charts are drawn by hand so the page has no
   external dependencies at all. */

'use strict';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  view: 'overview',
  data: {},            // endpoint -> payload
  tournamentId: null,
  playerId: null,
  sort: {},            // table id -> {key, dir}
  search: {},          // table id -> string
  tableView: {},       // chart id -> bool
};

const resizeHooks = [];

/* ------------------------------------------------------------ formatting */

const fmtInt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));

function fmtCompact(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M';
  if (abs >= 1e4) return (n / 1e3).toFixed(0) + 'K';
  return Number(n).toLocaleString('en-US');
}

const fmtMoney = (n) => (n === null || n === undefined ? '—' : '$' + fmtCompact(n));

/** Golf convention: level par prints as E, over par carries an explicit +. */
function fmtPar(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  if (Number.isNaN(v)) return String(n);
  if (v === 0) return 'E';
  return v > 0 ? '+' + v : String(v);
}

function fmtParFixed(n, places = 2) {
  if (n === null || n === undefined) return '—';
  const v = Number(n);
  if (v === 0) return 'E';
  return (v > 0 ? '+' : '') + v.toFixed(places);
}

function fmtDate(iso, opts) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
  return d.toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* ---------------------------------------------------------------- fetch */

async function load(path, { force = false } = {}) {
  if (!force && state.data[path]) return state.data[path];
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  state.data[path] = body;
  return body;
}

/* -------------------------------------------------------------- svg bits */

const NS = 'http://www.w3.org/2000/svg';

function S(tag, attrs = {}, children = []) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Column growing up from a baseline: rounded at the data end, square at the base. */
function colPath(x, y, w, h, r) {
  if (h <= 0.5) return `M${x},${y + h}h${w}`;
  const rad = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}L${x},${y + rad}Q${x},${y} ${x + rad},${y}` +
         `L${x + w - rad},${y}Q${x + w},${y} ${x + w},${y + rad}L${x + w},${y + h}Z`;
}

/** Horizontal bar from a baseline at x0; dir 1 grows right, -1 grows left. */
function barPath(x0, y, len, h, r, dir) {
  const rad = Math.max(0, Math.min(r, h / 2, len));
  if (len <= 0.5) return `M${x0},${y}v${h}`;
  if (dir >= 0) {
    const x1 = x0 + len;
    return `M${x0},${y}L${x1 - rad},${y}Q${x1},${y} ${x1},${y + rad}` +
           `L${x1},${y + h - rad}Q${x1},${y + h} ${x1 - rad},${y + h}L${x0},${y + h}Z`;
  }
  const x1 = x0 - len;
  return `M${x0},${y}L${x1 + rad},${y}Q${x1},${y} ${x1},${y + rad}` +
         `L${x1},${y + h - rad}Q${x1},${y + h} ${x1 + rad},${y + h}L${x0},${y + h}Z`;
}

/** Axis ticks on round numbers. */
function niceTicks(min, max, count = 5) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) {
    ticks.push(Math.abs(t) < 1e-9 ? 0 : Number(t.toFixed(10)));
  }
  return ticks;
}

/* -------------------------------------------------------------- tooltip */

const tooltip = {
  el: null,
  show(html, evt) {
    if (!this.el) this.el = $('#tooltip');
    this.el.innerHTML = html;
    this.el.hidden = false;
    this.move(evt);
  },
  move(evt) {
    if (!this.el || this.el.hidden) return;
    const pad = 14;
    const rect = this.el.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
    this.el.style.left = Math.max(8, x) + 'px';
    this.el.style.top = Math.max(8, y) + 'px';
  },
  hide() { if (this.el) this.el.hidden = true; },
};

/** Attach hover + keyboard tooltip behaviour to a hit target. */
function hoverable(node, html) {
  node.setAttribute('tabindex', '0');
  node.addEventListener('mouseenter', (e) => tooltip.show(html, e));
  node.addEventListener('mousemove', (e) => tooltip.move(e));
  node.addEventListener('mouseleave', () => tooltip.hide());
  node.addEventListener('focus', (e) => {
    const r = node.getBoundingClientRect();
    tooltip.show(html, { clientX: r.left + r.width / 2, clientY: r.top });
  });
  node.addEventListener('blur', () => tooltip.hide());
  return node;
}

/* --------------------------------------------------------- chart panels */

/** Charts re-render at the container's real pixel width so text never scales.
 *  A panel is still detached when it is built, so the first real draw happens
 *  once the view is in the document — see render(). */
function mountChart(host, render) {
  const draw = () => {
    const width = host.clientWidth;
    if (width < 40) return;
    host.replaceChildren(render(width));
  };
  draw();
  resizeHooks.push(draw);
}

/**
 * A chart card with a table-view twin. Every value shown as a mark is also
 * reachable as text — no value is gated behind a tooltip.
 */
function chartPanel({ id, title, note, legend, render, table, className = '' }) {
  const panel = document.createElement('section');
  panel.className = 'panel ' + className;

  const head = document.createElement('div');
  head.className = 'panel-head';
  head.innerHTML = `<h2>${esc(title)}</h2>`;
  panel.appendChild(head);

  if (note) {
    const p = document.createElement('p');
    p.className = 'panel-note';
    p.innerHTML = note;
    panel.appendChild(p);
  }

  if (legend) {
    const l = document.createElement('div');
    l.className = 'legend';
    l.innerHTML = legend;
    panel.appendChild(l);
  }

  const body = document.createElement('div');
  panel.appendChild(body);

  const foot = document.createElement('div');
  foot.className = 'chart-foot';
  const toggle = document.createElement('button');
  toggle.className = 'mini-btn';
  toggle.type = 'button';
  foot.appendChild(document.createElement('span'));
  foot.appendChild(toggle);
  panel.appendChild(foot);

  const paint = () => {
    const asTable = !!state.tableView[id];
    toggle.textContent = asTable ? 'Chart view' : 'Table view';
    body.replaceChildren();
    if (asTable) {
      body.appendChild(table());
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'chart-wrap';
      body.appendChild(wrap);
      mountChart(wrap, render);
    }
  };
  toggle.addEventListener('click', () => {
    state.tableView[id] = !state.tableView[id];
    paint();
  });
  paint();
  return panel;
}

/* ----------------------------------------------------------- chart types */

/**
 * Vertical columns from a zero baseline, single series.
 * rows: {label, value, tip, muted}
 */
function columnChart(rows, width, opts = {}) {
  const {
    height = 220, valueFmt = fmtInt, colour = 'var(--seq-450)',
    yTitle = '', labelExtremes = true, labelAll = false,
    minBarPx = 1,
  } = opts;

  const m = { top: yTitle ? 30 : 18, right: 12, bottom: 34, left: 46 };
  const plotW = Math.max(10, width - m.left - m.right);
  const plotH = height - m.top - m.bottom;

  const values = rows.map((r) => r.value);
  const maxV = Math.max(0, ...values);
  const minV = Math.min(0, ...values);
  const ticks = niceTicks(minV, maxV, 4);
  const lo = Math.min(minV, ticks[0]);
  const hi = Math.max(maxV, ticks[ticks.length - 1]);
  const yOf = (v) => m.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  const band = plotW / rows.length;
  const barW = Math.max(2, Math.min(24, band - 2));   // 2px surface gap between neighbours

  const svg = S('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });

  ticks.forEach((t) => {
    svg.appendChild(S('line', {
      class: 'grid-line', x1: m.left, x2: m.left + plotW, y1: yOf(t), y2: yOf(t),
    }));
    svg.appendChild(S('text', {
      class: 'axis-text', x: m.left - 8, y: yOf(t) + 3.5, 'text-anchor': 'end',
    }, valueFmt(t)));
  });

  const base = yOf(0);
  svg.appendChild(S('line', { class: 'axis-line', x1: m.left, x2: m.left + plotW, y1: base, y2: base }));

  const maxIdx = values.indexOf(Math.max(...values));
  const minIdx = values.indexOf(Math.min(...values));

  rows.forEach((row, i) => {
    const x = m.left + i * band + (band - barW) / 2;
    const v = row.value;
    const yv = yOf(v);
    const up = v >= 0;
    const h = Math.max(minBarPx, Math.abs(yv - base));
    const top = up ? base - h : base;

    svg.appendChild(S('path', {
      d: colPath(x, top, barW, h, 4),
      fill: row.muted ? 'var(--grid)' : colour,
      transform: up ? null : `rotate(180 ${x + barW / 2} ${top + h / 2})`,
    }));

    const hit = S('rect', {
      class: 'bar-hit', x: m.left + i * band, y: m.top, width: band, height: plotH,
      role: 'graphics-symbol', 'aria-label': `${row.label}: ${valueFmt(v)}`,
    });
    hoverable(hit, row.tip || `<strong>${esc(row.label)}</strong><span class="tt-row">${valueFmt(v)}</span>`);
    svg.appendChild(hit);

    const wantLabel = labelAll || (labelExtremes && (i === maxIdx || i === minIdx));
    if (wantLabel) {
      svg.appendChild(S('text', {
        class: 'mark-label', x: x + barW / 2, y: up ? top - 5 : top + h + 12, 'text-anchor': 'middle',
      }, valueFmt(v)));
    }

    // `short` is the axis label; an empty string means "no label on this band".
    // Category labels sit against the zero baseline on the opposite side from
    // the bar, so they never collide with the value label at the data end.
    const axisLabel = row.short === undefined ? row.label : row.short;
    if (axisLabel) {
      svg.appendChild(S('text', {
        class: 'axis-text', x: x + barW / 2, y: up ? base + 15 : base - 7, 'text-anchor': 'middle',
      }, axisLabel));
    }
  });

  if (yTitle) {
    svg.appendChild(S('text', {
      class: 'axis-title', x: 0, y: 10, 'text-anchor': 'start',
    }, yTitle));
  }
  return svg;
}

/**
 * Horizontal diverging bars around a zero baseline.
 * rows: {label, value, tip}
 */
function divergingBars(rows, width, opts = {}) {
  const {
    rowH = 17, labelW = 236, valueFmt = (v) => fmtParFixed(v, 2),
    coolLabel = '', warmLabel = '',
  } = opts;

  const m = { top: 26, right: 58, bottom: 26, left: labelW };
  const plotW = Math.max(40, width - m.left - m.right);
  const height = m.top + rows.length * rowH + m.bottom;

  const extent = Math.max(...rows.map((r) => Math.abs(r.value))) || 1;
  // The scale must cover the data, not just the round tick values -- otherwise
  // any bar past the outermost tick renders outside the plot.
  const span = extent;
  const ticks = niceTicks(-extent, extent, 4).filter((t) => Math.abs(t) <= span);
  const xOf = (v) => m.left + plotW / 2 + (v / span) * (plotW / 2);

  const svg = S('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' });
  const barH = Math.min(11, rowH - 4);

  ticks.forEach((t) => {
    svg.appendChild(S('line', {
      class: t === 0 ? 'axis-line' : 'grid-line',
      x1: xOf(t), x2: xOf(t), y1: m.top - 6, y2: m.top + rows.length * rowH,
    }));
    svg.appendChild(S('text', {
      class: 'axis-text', x: xOf(t), y: m.top - 12, 'text-anchor': 'middle',
    }, t === 0 ? 'E' : fmtParFixed(t, 0)));
  });

  if (coolLabel) {
    svg.appendChild(S('text', { class: 'axis-title', x: m.left, y: height - 8, 'text-anchor': 'start' }, coolLabel));
  }
  if (warmLabel) {
    svg.appendChild(S('text', { class: 'axis-title', x: m.left + plotW, y: height - 8, 'text-anchor': 'end' }, warmLabel));
  }

  rows.forEach((row, i) => {
    const y = m.top + i * rowH + (rowH - barH) / 2;
    const v = row.value;
    const len = Math.abs(xOf(v) - xOf(0));
    const dir = v >= 0 ? 1 : -1;

    svg.appendChild(S('path', {
      d: barPath(xOf(0), y, len, barH, 4, dir),
      fill: v >= 0 ? 'var(--div-warm)' : 'var(--div-cool)',
    }));

    svg.appendChild(S('text', {
      class: 'mark-label', x: m.left - 10, y: y + barH - 1.5, 'text-anchor': 'end',
    }, row.label.length > 34 ? row.label.slice(0, 33) + '…' : row.label));

    svg.appendChild(S('text', {
      class: 'mark-label', x: m.left + plotW + 8, y: y + barH - 1.5, 'text-anchor': 'start',
    }, valueFmt(v)));

    const hit = S('rect', {
      class: 'bar-hit', x: m.left - labelW + 8, y: m.top + i * rowH,
      width: width - 16, height: rowH,
      role: 'graphics-symbol', 'aria-label': `${row.label}: ${valueFmt(v)}`,
    });
    hoverable(hit, row.tip || `<strong>${esc(row.label)}</strong><span class="tt-row">${valueFmt(v)}</span>`);
    svg.appendChild(hit);
  });

  return svg;
}

/** One horizontal stacked bar, part-to-whole across a few categories. */
function stackedBar(segments, width, opts = {}) {
  const { height = 22 } = opts;
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const gap = 2;
  const usable = width - gap * (segments.length - 1);

  const svg = S('svg', { width, height: height + 4, viewBox: `0 0 ${width} ${height + 4}`, role: 'img' });
  let x = 0;
  segments.forEach((seg) => {
    const w = (seg.value / total) * usable;
    const g = S('g');
    g.appendChild(S('rect', { x, y: 0, width: Math.max(w, 1), height, rx: 3, fill: seg.colour }));
    const label = `${seg.label} ${Math.round((seg.value / total) * 100)}%`;
    // Only label inside the segment when the text actually fits.
    if (w > label.length * 6.4 + 16) {
      g.appendChild(S('text', {
        x: x + w / 2, y: height / 2 + 4, 'text-anchor': 'middle',
        fill: seg.ink || '#fff', 'font-size': 11.5, 'font-family': 'var(--font)', 'font-weight': 560,
      }, label));
    }
    const hit = S('rect', { class: 'bar-hit', x, y: 0, width: Math.max(w, 1), height });
    hoverable(hit, `<strong>${esc(seg.label)}</strong><span class="tt-row">${fmtInt(seg.value)} results · ${((seg.value / total) * 100).toFixed(1)}%</span>`);
    g.appendChild(hit);
    svg.appendChild(g);
    x += w + gap;
  });
  return svg;
}

/* ---------------------------------------------------------------- tables */

/**
 * Sortable, optionally searchable table.
 * columns: {key, label, num, fmt, cls, sortable, sortValue}
 */
function dataTable(id, columns, rows, opts = {}) {
  const { onRowClick, rowId, selectedId, initialSort, maxHeight, searchKeys, searchBox, emptyText } = opts;

  const wrap = document.createElement('div');

  let visible = rows;
  const term = (state.search[id] || '').trim().toLowerCase();
  if (term && searchKeys) {
    visible = rows.filter((r) => searchKeys.some((k) => String(r[k] || '').toLowerCase().includes(term)));
  }

  if (!state.sort[id] && initialSort) state.sort[id] = { ...initialSort };
  const sort = state.sort[id];
  if (sort) {
    const col = columns.find((c) => c.key === sort.key);
    visible = visible.slice().sort((a, b) => {
      const get = col && col.sortValue ? col.sortValue : (r) => r[sort.key];
      let av = get(a), bv = get(b);
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string' && typeof bv === 'string') {
        return sort.dir * av.localeCompare(bv);
      }
      return sort.dir * (Number(av) - Number(bv));
    });
  }

  if (searchBox) {
    const bar = document.createElement('div');
    bar.className = 'filter-row';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = searchBox;
    input.value = state.search[id] || '';
    input.addEventListener('input', () => {
      state.search[id] = input.value;
      const fresh = dataTable(id, columns, rows, opts);
      wrap.replaceWith(fresh);
      const box = $('input[type="search"]', fresh);
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    });
    bar.appendChild(input);
    const count = document.createElement('span');
    count.className = 'filter-count';
    count.textContent = `${fmtInt(visible.length)} of ${fmtInt(rows.length)}`;
    bar.appendChild(count);
    wrap.appendChild(bar);
  }

  const scroll = document.createElement('div');
  scroll.className = 'table-scroll' + (maxHeight === 'short' ? ' short' : '');
  if (typeof maxHeight === 'number') scroll.style.maxHeight = maxHeight + 'px';

  const table = document.createElement('table');
  table.className = 'data';

  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  columns.forEach((col) => {
    const th = document.createElement('th');
    th.textContent = col.label;
    if (col.num) th.classList.add('num');
    if (col.sortable !== false) {
      th.classList.add('sortable');
      if (sort && sort.key === col.key) {
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = sort.dir === 1 ? '▲' : '▼';
        th.appendChild(arrow);
      }
      th.addEventListener('click', () => {
        const cur = state.sort[id];
        state.sort[id] = (cur && cur.key === col.key)
          ? { key: col.key, dir: -cur.dir }
          : { key: col.key, dir: col.num ? -1 : 1 };
        wrap.replaceWith(dataTable(id, columns, rows, opts));
      });
    }
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!visible.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length;
    td.className = 'empty';
    td.textContent = emptyText || 'Nothing matches that search.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  visible.forEach((row) => {
    const tr = document.createElement('tr');
    if (onRowClick) {
      tr.className = 'clickable';
      tr.tabIndex = 0;
      tr.addEventListener('click', () => onRowClick(row));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); }
      });
    }
    if (rowId && selectedId && rowId(row) === selectedId) tr.classList.add('is-selected');
    columns.forEach((col) => {
      const td = document.createElement('td');
      if (col.num) td.classList.add('num');
      if (col.cls) td.classList.add(col.cls);
      const content = col.fmt ? col.fmt(row) : row[col.key];
      if (content instanceof Node) td.appendChild(content);
      else td.innerHTML = content === null || content === undefined || content === '' ? '<span class="muted">—</span>' : content;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  scroll.appendChild(table);
  wrap.appendChild(scroll);
  return wrap;
}

/* ----------------------------------------------------------- small parts */

function panel(title, note, ...children) {
  const el = document.createElement('section');
  el.className = 'panel';
  el.innerHTML = `<div class="panel-head"><h2>${esc(title)}</h2></div>` +
                 (note ? `<p class="panel-note">${note}</p>` : '');
  children.filter(Boolean).forEach((c) => el.appendChild(c));
  return el;
}

function tiles(items) {
  const el = document.createElement('div');
  el.className = 'tiles';
  el.innerHTML = items.map((t) => `
    <div class="tile">
      <div class="tile-label">${esc(t.label)}</div>
      <div class="tile-value">${t.value}</div>
      ${t.sub ? `<div class="tile-sub">${t.sub}</div>` : ''}
    </div>`).join('');
  return el;
}

function node(html) {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild;
}

const roundsCell = (detail) => {
  if (!detail || !detail.length) return '<span class="muted">—</span>';
  return '<span class="rounds">' + detail.map((r) => `<b>${r.strokes}</b>`).join('<i class="muted">·</i>') + '</span>';
};

function positionCell(row) {
  const pos = row.finish_position;
  if (!pos) return '<span class="muted">—</span>';
  if (row.finish_rank === 1) return '<span class="pill win">1st</span>';
  if (pos === 'CUT' || pos === 'WD' || pos === 'DQ') return `<span class="pill cut">${pos}</span>`;
  return esc(pos);
}

const parCell = (v) => (v === null || v === undefined
  ? '<span class="muted">—</span>'
  : `<span class="${v < 0 ? 'under' : 'over'}">${fmtPar(v)}</span>`);

/* ------------------------------------------------------------- overview */

async function viewOverview(root) {
  const d = await load('/api/overview');
  const inv = d.inventory;
  const teamOnly = inv.checkpoints_complete - inv.tournaments;

  setHead('Overview',
    `Everything the pipeline has published from the ${esc(inv.first_event.slice(0, 4))} PGA TOUR season, ` +
    `from raw API payloads through to season totals.`);

  /* Hero + headline tiles */
  const hero = node(`
    <section class="panel hero-panel">
      <div>
        <div class="hero-label">Published player results</div>
        <div class="hero-value">${fmtInt(inv.player_results)}</div>
        <p class="hero-caption">One row per player per completed event —
          ${fmtDate(inv.first_event, { month: 'long', day: 'numeric' })} to
          ${fmtDate(inv.last_event, { month: 'long', day: 'numeric', year: 'numeric' })}.</p>
      </div>
      <div></div>
    </section>`);
  hero.lastElementChild.replaceWith(tiles([
    { label: 'Tournaments loaded', value: fmtInt(inv.checkpoints_complete), sub: `${inv.tournaments} stroke play · ${teamOnly} team only` },
    { label: 'Players', value: fmtInt(inv.players), sub: 'distinct competitors' },
    { label: 'Round scores', value: fmtInt(inv.round_records), sub: 'in the raw payloads' },
    { label: 'Courses', value: fmtInt(inv.courses), sub: 'named in round data' },
    { label: 'Strokes counted', value: fmtCompact(inv.total_strokes), sub: 'across every round' },
  ]));
  root.appendChild(hero);

  /* Warehouse layers */
  const layers = document.createElement('div');
  layers.className = 'layers';
  const rows = [
    { name: 'raw', desc: 'Untouched API payloads as JSONB, one row per result record, plus the cached schedule.', count: inv.raw_results, unit: 'records', extra: `${inv.raw_runs} ingestion runs` },
    { name: 'ops', desc: 'One checkpoint per tournament. A completed checkpoint is what makes an event publishable.', count: inv.checkpoints, unit: 'checkpoints', extra: `${inv.checkpoints_complete} complete` },
    { name: 'analytics', desc: 'Typed, deduplicated results — the layer this dashboard reads.', count: inv.player_results + inv.team_results, unit: 'rows', extra: `${fmtInt(inv.player_results)} player · ${inv.team_results} team` },
  ];
  rows.forEach((r, i) => {
    layers.appendChild(node(`
      <div class="layer">
        <span class="layer-name">${r.name}</span>
        <span class="layer-desc">${esc(r.desc)}<br><code>${esc(r.extra)}</code></span>
        <span class="layer-count">${fmtInt(r.count)} <span class="muted" style="font-weight:420;font-size:11px">${r.unit}</span></span>
      </div>`));
    if (i < rows.length - 1) layers.appendChild(node('<div class="layer-arrow">↓</div>'));
  });
  root.appendChild(panel(
    'How the warehouse is layered',
    `Raw payloads are never edited. ${fmtInt(inv.raw_excluded)} raw records sit outside analytics on purpose — ` +
    `a 2024 demonstration load and practice snapshots that were kept for provenance but never published.`,
    layers));

  /* Coverage + outcome mix */
  const cov = await load('/api/pipeline');
  const today = new Date().toISOString().slice(0, 10);
  const loaded = cov.coverage.filter((c) => c.loaded).length;
  const upcoming = cov.coverage.filter((c) => !c.loaded && c.event_end_date > today).length;
  const missing = cov.coverage.length - loaded - upcoming;

  const meter = node(`
    <div>
      <div class="meter-track">
        <div class="meter-fill" style="width:${(loaded / cov.coverage.length) * 100}%"></div>
      </div>
      <div class="meter-legend">
        <span><i class="swatch" style="background:var(--seq-450)"></i>${loaded} loaded</span>
        <span><i class="swatch" style="background:var(--seq-200)"></i>${upcoming} not yet played</span>
        ${missing ? `<span><i class="swatch" style="background:var(--critical)"></i>${missing} played but missing</span>` : ''}
      </div>
    </div>`);

  const outcomeOrder = ['complete', 'cut', 'wd', 'dq'];
  const outcomeMeta = {
    complete: { label: 'Completed', colour: 'var(--series-1)' },
    cut:      { label: 'Missed cut', colour: 'var(--series-2)' },
    wd:       { label: 'Withdrew', colour: 'var(--series-3)' },
    dq:       { label: 'Disqualified', colour: 'var(--series-4)' },
  };
  const segments = outcomeOrder
    .map((k) => ({ ...outcomeMeta[k], value: (d.outcomes.find((o) => o.status === k) || {}).results || 0 }))
    .filter((s) => s.value > 0);

  const outcomePanel = chartPanel({
    id: 'outcomes',
    title: 'How player entries ended',
    note: 'Every published result carries a status. Cuts are the reason most players have only two rounds.',
    legend: segments.map((s) => `<span><i class="swatch" style="background:${s.colour}"></i>${s.label}</span>`).join(''),
    render: (w) => stackedBar(segments, w),
    table: () => dataTable('outcomes-tbl',
      [{ key: 'label', label: 'Outcome' },
       { key: 'value', label: 'Results', num: true, fmt: (r) => fmtInt(r.value) },
       { key: 'pct', label: 'Share', num: true, fmt: (r) => ((r.value / inv.player_results) * 100).toFixed(1) + '%' }],
      segments, { initialSort: { key: 'value', dir: -1 } }),
  });

  const nextUp = cov.coverage
    .filter((c) => !c.loaded && c.event_end_date > today)
    .slice(0, 4)
    .map((c) => `<li>${fmtDate(c.event_end_date)} — ${esc(c.tournament_name)}</li>`)
    .join('');
  if (nextUp) {
    meter.appendChild(node(`
      <div style="margin-top:16px">
        <div class="tile-label" style="margin-bottom:6px">Next events the pipeline will pick up</div>
        <ul style="margin:0;padding-left:18px;font-size:12.5px;color:var(--text-secondary);line-height:1.7">${nextUp}</ul>
      </div>`));
  }

  const row = document.createElement('div');
  row.className = 'grid-2';
  row.appendChild(panel(
    'Season coverage',
    `The cached schedule lists ${cov.coverage.length} events for this season. ` +
    `The ${upcoming} that are not loaded simply have not been played yet — the pipeline only takes completed, Official events.`,
    meter));
  row.appendChild(outcomePanel);
  root.appendChild(row);

  /* Season timeline */
  const tl = d.timeline;
  root.appendChild(chartPanel({
    id: 'timeline',
    title: 'Field size across the season',
    note: 'Each column is one loaded tournament, in date order. Full-field events run 144–156 players; ' +
          'the small columns late in the season are the FedExCup playoff events, which invite progressively fewer players.',
    render: (w) => columnChart(tl.map((t, i) => ({
      label: t.tournament_name,
      short: i % 5 === 0 ? fmtDate(t.event_end_date) : '',
      value: Number(t.field_size),
      tip: `<strong>${esc(t.tournament_name)}</strong>
            <span class="tt-row">${fmtDate(t.event_end_date, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            <span class="tt-row">${t.field_size} players · ${t.missed_cut} missed the cut</span>
            <span class="tt-row">Purse ${fmtMoney(t.purse)}</span>`,
    })), w, { height: 240, yTitle: 'players in the field' }),
    table: () => dataTable('timeline-tbl',
      [{ key: 'event_end_date', label: 'Ends', fmt: (r) => fmtDate(r.event_end_date) },
       { key: 'tournament_name', label: 'Tournament', cls: 'wide' },
       { key: 'field_size', label: 'Field', num: true },
       { key: 'missed_cut', label: 'Missed cut', num: true },
       { key: 'purse', label: 'Purse', num: true, fmt: (r) => fmtMoney(r.purse) }],
      tl, { initialSort: { key: 'event_end_date', dir: 1 }, maxHeight: 'short' }),
  }));

  setFreshness(inv);
}

/* ---------------------------------------------------------- tournaments */

async function viewTournaments(root) {
  const { tournaments } = await load('/api/tournaments');
  setHead('Tournaments',
    `${tournaments.length} completed events with published results. Select a row to open its full leaderboard.`);

  const columns = [
    { key: 'event_end_date', label: 'Ends', fmt: (r) => fmtDate(r.event_end_date) },
    { key: 'tournament_name', label: 'Tournament', cls: 'wide' },
    { key: 'course_name', label: 'Course', cls: 'wide',
      fmt: (r) => esc(r.course_name || '') + (r.course_count > 1 ? ` <span class="muted">+${r.course_count - 1}</span>` : '') },
    { key: 'field_size', label: 'Field', num: true },
    { key: 'missed_cut', label: 'Cut', num: true, fmt: (r) => (r.missed_cut ? fmtInt(r.missed_cut) : '<span class="muted">no cut</span>') },
    { key: 'winner', label: 'Winner', fmt: (r) => (r.winner ? esc(r.winner) : '<span class="muted">team event</span>') },
    { key: 'winning_score', label: 'Score', num: true, fmt: (r) => parCell(r.winning_score) },
    { key: 'purse', label: 'Purse', num: true, fmt: (r) => fmtMoney(r.purse) },
  ];

  const detail = document.createElement('div');

  const table = dataTable('tournaments', columns, tournaments, {
    initialSort: { key: 'event_end_date', dir: -1 },
    searchBox: 'Search tournaments, courses, winners…',
    searchKeys: ['tournament_name', 'course_name', 'winner'],
    rowId: (r) => r.tournament_id,
    selectedId: state.tournamentId,
    onRowClick: (r) => { state.tournamentId = r.tournament_id; render(); },
  });

  root.appendChild(panel('All loaded events', null, table));
  root.appendChild(detail);

  if (state.tournamentId) {
    detail.appendChild(node('<div class="loading">Loading leaderboard…</div>'));
    const lb = await load(`/api/tournaments/${encodeURIComponent(state.tournamentId)}`);
    detail.replaceChildren(tournamentDetail(lb));
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function tournamentDetail(lb) {
  const h = lb.header || {};
  const wrap = document.createElement('section');
  wrap.className = 'panel';

  wrap.appendChild(node(`
    <div class="detail-head">
      <h2>${esc(h.tournament_name || 'Leaderboard')}</h2>
      <div class="detail-meta">
        <span>Ends ${fmtDate(h.event_end_date, { month: 'long', day: 'numeric', year: 'numeric' })}</span>
        <span>Purse ${fmtMoney(h.purse)}</span>
        <span>Winner's share ${fmtMoney(h.winners_share)}</span>
        <span>Cut ${h.cut_score ? fmtPar(Number(h.cut_score)) : 'none'}</span>
        <span>${esc(h.format || '')} play</span>
      </div>
    </div>`));

  if (lb.players.length) {
    wrap.appendChild(dataTable('leaderboard-' + h.tournament_id, [
      { key: 'finish_position', label: 'Pos', fmt: positionCell,
        sortValue: (r) => (r.finish_rank === null ? 9999 : r.finish_rank) },
      { key: 'player_name', label: 'Player', cls: 'name' },
      { key: 'score_to_par', label: 'To par', num: true, fmt: (r) => parCell(r.score_to_par) },
      { key: 'total_strokes', label: 'Strokes', num: true, fmt: (r) => fmtInt(r.total_strokes) },
      { key: 'rounds', label: 'Rounds', sortable: false, fmt: (r) => roundsCell(r.round_detail) },
      { key: 'player_status', label: 'Status', fmt: (r) => `<span class="muted">${esc(r.player_status || '')}</span>` },
    ], lb.players, {
      initialSort: { key: 'finish_position', dir: 1 },
      searchBox: 'Search this field…',
      searchKeys: ['player_name'],
    }));
  }

  if (lb.teams.length) {
    const teamRows = lb.teams.map((t) => ({
      ...t,
      team_label: (t.players || []).map((p) => `${p.firstName} ${p.lastName}`).join(' / '),
    }));
    wrap.appendChild(node('<p class="panel-note" style="margin-top:18px">Team results are stored separately so a team score never counts as an individual win.</p>'));
    wrap.appendChild(dataTable('teams-' + h.tournament_id, [
      { key: 'finish_position', label: 'Pos',
        sortValue: (r) => Number(String(r.finish_position || '').replace(/\D/g, '')) || 9999 },
      { key: 'team_label', label: 'Team', cls: 'name' },
      { key: 'score_to_par', label: 'To par', num: true, fmt: (r) => parCell(r.score_to_par) },
    ], teamRows, { initialSort: { key: 'finish_position', dir: 1 } }));
  }
  return wrap;
}

/* --------------------------------------------------------------- players */

async function viewPlayers(root) {
  const { players } = await load('/api/players');
  setHead('Players',
    `${players.length} players have at least one published result. Season totals are computed from loaded events only.`);

  const columns = [
    { key: 'player_name', label: 'Player', cls: 'name' },
    { key: 'events_played', label: 'Events', num: true },
    { key: 'wins', label: 'Wins', num: true, fmt: (r) => (r.wins ? `<span class="pill win">${r.wins}</span>` : '<span class="muted">0</span>') },
    { key: 'top_10s', label: 'Top 10s', num: true },
    { key: 'cuts', label: 'Missed cuts', num: true },
    { key: 'best_finish', label: 'Best', num: true, fmt: (r) => (r.best_finish ? fmtInt(r.best_finish) : '<span class="muted">—</span>') },
    { key: 'rounds_logged', label: 'Rounds', num: true },
    { key: 'scoring_avg', label: 'Scoring avg', num: true, fmt: (r) => (r.scoring_avg ? Number(r.scoring_avg).toFixed(2) : '—') },
    { key: 'latest_event_date', label: 'Last seen', fmt: (r) => fmtDate(r.latest_event_date) },
  ];

  const detail = document.createElement('div');

  root.appendChild(panel('Season records', null, dataTable('players', columns, players, {
    initialSort: { key: 'wins', dir: -1 },
    searchBox: 'Search players…',
    searchKeys: ['player_name'],
    rowId: (r) => r.player_id,
    selectedId: state.playerId,
    onRowClick: (r) => { state.playerId = r.player_id; render(); },
    maxHeight: 520,
  })));
  root.appendChild(detail);

  if (state.playerId) {
    detail.appendChild(node('<div class="loading">Loading player…</div>'));
    const pd = await load(`/api/players/${encodeURIComponent(state.playerId)}`);
    detail.replaceChildren(playerDetail(pd));
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function playerDetail(pd) {
  const s = pd.summary || {};
  const wrap = document.createElement('div');
  wrap.className = 'view';

  const head = document.createElement('section');
  head.className = 'panel';
  head.appendChild(node(`
    <div class="detail-head">
      <h2>${esc(s.player_name || 'Player')}</h2>
      <div class="detail-meta"><span>player_id ${esc(s.player_id || '')}</span></div>
    </div>`));
  head.appendChild(tiles([
    { label: 'Events', value: fmtInt(s.events_played) },
    { label: 'Wins', value: fmtInt(s.wins) },
    { label: 'Top 10s', value: fmtInt(s.top_10s) },
    { label: 'Missed cuts', value: fmtInt(s.cuts) },
    { label: 'Rounds', value: fmtInt(s.rounds_logged) },
    { label: 'Scoring avg', value: s.scoring_avg ? Number(s.scoring_avg).toFixed(2) : '—', sub: s.avg_to_par !== null && s.avg_to_par !== undefined ? fmtParFixed(s.avg_to_par) + ' per round' : '' },
    { label: 'Low round', value: fmtInt(s.best_round) },
  ]));
  wrap.appendChild(head);

  /* Finish positions across the season — lower is better, so the axis is inverted. */
  const played = pd.history.filter((h) => h.finish_rank !== null);
  if (played.length) {
    wrap.appendChild(chartPanel({
      id: 'player-finishes-' + s.player_id,
      title: 'Finishing position, event by event',
      note: 'Only events with a numeric finish appear here — missed cuts, withdrawals and disqualifications have no rank. ' +
            'Shorter columns are better finishes.',
      render: (w) => columnChart(played.map((h) => ({
        label: h.tournament_name,
        short: '',
        value: Number(h.finish_rank),
        tip: `<strong>${esc(h.tournament_name)}</strong>
              <span class="tt-row">${fmtDate(h.event_end_date, { month: 'short', day: 'numeric' })} · finished ${esc(h.finish_position)}</span>
              <span class="tt-row">${fmtPar(h.score_to_par)} · ${fmtInt(h.total_strokes)} strokes</span>`,
      })), w, { height: 190, colour: 'var(--seq-450)', yTitle: 'finishing position', labelExtremes: true }),
      table: () => historyTable(pd.history, s.player_id),
    }));
  }

  wrap.appendChild(panel('Every event this season', null, historyTable(pd.history, s.player_id)));
  return wrap;
}

function historyTable(history, pid) {
  return dataTable('player-history-' + pid, [
    { key: 'event_end_date', label: 'Ends', fmt: (r) => fmtDate(r.event_end_date) },
    { key: 'tournament_name', label: 'Tournament', cls: 'wide' },
    { key: 'finish_position', label: 'Pos', fmt: positionCell,
      sortValue: (r) => (r.finish_rank === null ? 9999 : r.finish_rank) },
    { key: 'score_to_par', label: 'To par', num: true, fmt: (r) => parCell(r.score_to_par) },
    { key: 'total_strokes', label: 'Strokes', num: true, fmt: (r) => fmtInt(r.total_strokes) },
    { key: 'rounds', label: 'Rounds', sortable: false, fmt: (r) => roundsCell(r.round_detail) },
  ], history, { initialSort: { key: 'event_end_date', dir: 1 } });
}

/* --------------------------------------------------------------- scoring */

async function viewScoring(root) {
  const d = await load('/api/scoring');
  const totalRounds = d.by_round.reduce((a, r) => a + Number(r.rounds_logged), 0);

  setHead('Scoring',
    `Round-level detail — ${fmtInt(totalRounds)}+ individual rounds unpacked from the raw JSON payloads. ` +
    `The analytics tables stop at one row per player per event; this grain lives inside the stored API response.`);

  root.appendChild(node(`
    <p class="callout">Course difficulty and round scoring are measured in strokes relative to par.
    Negative means the field played under par. These are averages over this dataset's loaded events, not official
    course ratings — a course played once in benign weather will look easier than it is.</p>`));

  /* Average to par by round number */
  root.appendChild(chartPanel({
    id: 'by-round',
    title: 'Average score to par, by round',
    note: 'Rounds 3 and 4 are played only by those who made the cut, so the weekend average is pulled down by a ' +
          'stronger surviving field — not necessarily by easier setups.',
    render: (w) => columnChart(d.by_round.map((r) => ({
      label: 'Round ' + r.round_no,
      short: 'R' + r.round_no,
      value: Number(r.avg_to_par),
      tip: `<strong>Round ${r.round_no}</strong>
            <span class="tt-row">${fmtParFixed(r.avg_to_par)} to par</span>
            <span class="tt-row">${fmtInt(r.rounds_logged)} rounds · ${Number(r.avg_strokes).toFixed(2)} strokes avg</span>`,
    })), w, {
      height: 200, labelAll: true, valueFmt: (v) => fmtParFixed(v, 2),
      colour: 'var(--seq-450)', yTitle: 'strokes vs par',
    }),
    table: () => dataTable('by-round-tbl', [
      { key: 'round_no', label: 'Round', fmt: (r) => 'Round ' + r.round_no },
      { key: 'rounds_logged', label: 'Rounds', num: true, fmt: (r) => fmtInt(r.rounds_logged) },
      { key: 'avg_strokes', label: 'Avg strokes', num: true, fmt: (r) => Number(r.avg_strokes).toFixed(2) },
      { key: 'avg_to_par', label: 'Avg to par', num: true, fmt: (r) => fmtParFixed(r.avg_to_par) },
    ], d.by_round, { initialSort: { key: 'round_no', dir: 1 } }),
  }));

  /* Distribution */
  const dist = d.distribution;
  root.appendChild(chartPanel({
    id: 'distribution',
    title: 'Distribution of individual round scores',
    note: 'How often each score relative to par occurred across every logged round. The mode sits just under par — ' +
          'tour scoring is tightly clustered, and the tails are thin in both directions.',
    render: (w) => columnChart(dist.map((r) => ({
      label: fmtPar(r.score_to_par) + ' to par',
      short: r.score_to_par % 3 === 0 ? fmtPar(r.score_to_par) : '',
      value: Number(r.rounds_logged),
      tip: `<strong>${fmtPar(r.score_to_par)} to par</strong>
            <span class="tt-row">${fmtInt(r.rounds_logged)} rounds
            (${((r.rounds_logged / totalRounds) * 100).toFixed(1)}%)</span>`,
    })), w, { height: 230, colour: 'var(--seq-450)', yTitle: 'rounds', labelExtremes: false }),
    table: () => dataTable('distribution-tbl', [
      { key: 'score_to_par', label: 'To par', fmt: (r) => fmtPar(r.score_to_par) },
      { key: 'rounds_logged', label: 'Rounds', num: true, fmt: (r) => fmtInt(r.rounds_logged) },
    ], dist, { initialSort: { key: 'score_to_par', dir: 1 }, maxHeight: 'short' }),
  }));

  /* Course difficulty */
  root.appendChild(chartPanel({
    id: 'courses',
    title: 'Course difficulty — average round score to par',
    note: `All ${d.courses.length} courses with at least 50 logged rounds, hardest first.`,
    legend: '<span><i class="swatch" style="background:var(--div-warm)"></i>Played over par (harder)</span>' +
            '<span><i class="swatch" style="background:var(--div-cool)"></i>Played under par (easier)</span>',
    render: (w) => divergingBars(d.courses.map((c) => ({
      label: c.course_name,
      value: Number(c.avg_to_par),
      tip: `<strong>${esc(c.course_name)}</strong>
            <span class="tt-row">${fmtParFixed(c.avg_to_par)} average to par</span>
            <span class="tt-row">${Number(c.avg_strokes).toFixed(2)} strokes · low round ${c.low_round}</span>
            <span class="tt-row">${fmtInt(c.rounds_logged)} rounds logged</span>`,
    })), w, { coolLabel: 'easier ←', warmLabel: '→ harder' }),
    table: () => dataTable('courses-tbl', [
      { key: 'course_name', label: 'Course', cls: 'wide' },
      { key: 'rounds_logged', label: 'Rounds', num: true, fmt: (r) => fmtInt(r.rounds_logged) },
      { key: 'avg_strokes', label: 'Avg strokes', num: true, fmt: (r) => Number(r.avg_strokes).toFixed(2) },
      { key: 'avg_to_par', label: 'Avg to par', num: true, fmt: (r) => fmtParFixed(r.avg_to_par) },
      { key: 'low_round', label: 'Low round', num: true },
    ], d.courses, { initialSort: { key: 'avg_to_par', dir: -1 } }),
  }));

  /* Low rounds */
  root.appendChild(panel('Lowest rounds of the season', 'Ranked by score to par, then by strokes.',
    dataTable('low-rounds', [
      { key: 'player_name', label: 'Player', cls: 'name' },
      { key: 'score_to_par', label: 'To par', num: true, fmt: (r) => parCell(r.score_to_par) },
      { key: 'strokes', label: 'Strokes', num: true },
      { key: 'round_no', label: 'Round', num: true, fmt: (r) => 'R' + r.round_no },
      { key: 'tournament_name', label: 'Tournament', cls: 'wide' },
      { key: 'course_name', label: 'Course', cls: 'wide' },
    ], d.low_rounds, { initialSort: { key: 'score_to_par', dir: 1 } })));
}

/* -------------------------------------------------------------- pipeline */

async function viewPipeline(root) {
  const d = await load('/api/pipeline');
  const today = new Date().toISOString().slice(0, 10);
  const loaded = d.coverage.filter((c) => c.loaded);
  const upcoming = d.coverage.filter((c) => !c.loaded && c.event_end_date > today);
  const missing = d.coverage.filter((c) => !c.loaded && c.event_end_date <= today);

  setHead('Pipeline',
    'How the data got here: what each run loaded, which events are checkpointed, and what the quality checks say.');

  root.appendChild(panel('Load state by scheduled event',
    `The cached schedule lists ${d.coverage.length} events. ${loaded.length} are loaded and published, ` +
    `${upcoming.length} have not been played yet` +
    (missing.length ? `, and ${missing.length} are past but absent — worth investigating.` : '. Nothing is unexpectedly absent.'),
    dataTable('coverage', [
      { key: 'loaded', label: 'State', fmt: (r) => {
        if (r.loaded) return '<span class="status-dot good"></span>loaded';
        if (r.event_end_date > today) return '<span class="muted">not yet played</span>';
        return '<span class="status-dot warn"></span>missing';
      }, sortValue: (r) => (r.loaded ? 0 : r.event_end_date > today ? 1 : 2) },
      { key: 'event_end_date', label: 'Ends', fmt: (r) => fmtDate(r.event_end_date, { month: 'short', day: 'numeric' }) },
      { key: 'tournament_name', label: 'Tournament', cls: 'wide' },
      { key: 'format', label: 'Format', fmt: (r) => `<span class="muted">${esc(r.format || '')}</span>` },
      { key: 'row_count', label: 'Rows', num: true, fmt: (r) => (r.row_count ? fmtInt(r.row_count) : '<span class="muted">—</span>') },
      { key: 'purse', label: 'Purse', num: true, fmt: (r) => fmtMoney(r.purse) },
    ], d.coverage, { initialSort: { key: 'event_end_date', dir: 1 }, maxHeight: 420 })));

  root.appendChild(panel('Quality checks',
    'Run against the live tables now. A non-zero count is not automatically a problem — several are expected ' +
    'consequences of how golf results work, which is why each carries an explanation.',
    dataTable('quality', [
      { key: 'check_name', label: 'Check', cls: 'wide' },
      { key: 'flagged', label: 'Flagged', num: true, fmt: (r) => fmtInt(r.flagged) },
      { key: 'total', label: 'Of', num: true, fmt: (r) => fmtInt(r.total) },
      { key: 'note', label: 'Interpretation', cls: 'wide', fmt: (r) => `<span class="muted">${esc(r.note)}</span>` },
    ], d.quality, { initialSort: { key: 'flagged', dir: -1 } })));

  const grid = document.createElement('div');
  grid.className = 'grid-2';
  // Published should always equal the checkpoint's own row count; showing both
  // makes a transform that silently dropped rows visible at a glance.
  const checkpoints = d.checkpoints.map((c) => ({ ...c, published: c.player_rows + c.team_rows }));
  grid.appendChild(panel('Tournament checkpoints',
    'One row per tournament. Analytics only reads events whose checkpoint is complete. ' +
    '"Published" counts the analytics rows that survived the transform — it should match the checkpoint.',
    dataTable('checkpoints', [
      { key: 'tournament_name', label: 'Tournament', cls: 'wide' },
      { key: 'status', label: 'Status', fmt: (r) => `<span class="pill ok">${esc(r.status)}</span>` },
      { key: 'row_count', label: 'Checkpoint', num: true, fmt: (r) => fmtInt(r.row_count) },
      { key: 'published', label: 'Published', num: true,
        fmt: (r) => (r.published === r.row_count
          ? fmtInt(r.published)
          : `<span style="color:var(--critical)">${fmtInt(r.published)}</span>`) },
    ], checkpoints, { initialSort: { key: 'row_count', dir: -1 }, maxHeight: 420 })));

  grid.appendChild(panel('Ingestion runs',
    'Every raw record carries the run that produced it, so any published number can be traced back to one API call.',
    dataTable('runs', [
      { key: 'source_run_id', label: 'Run', fmt: (r) => `<span class="muted" style="font-family:ui-monospace,Consolas,monospace">${esc(r.source_run_id.slice(0, 8))}</span>` },
      { key: 'raw_rows', label: 'Rows', num: true, fmt: (r) => fmtInt(r.raw_rows) },
      { key: 'started', label: 'Ingested', fmt: (r) => fmtDateTime(r.started) },
    ], d.runs, { initialSort: { key: 'started', dir: -1 }, maxHeight: 420 })));
  root.appendChild(grid);
}

/* ----------------------------------------------------------------- shell */

const VIEWS = {
  overview: viewOverview,
  tournaments: viewTournaments,
  players: viewPlayers,
  scoring: viewScoring,
  pipeline: viewPipeline,
};

function setHead(title, sub) {
  $('#view-title').textContent = title;
  $('#view-sub').innerHTML = sub;
}

function setFreshness(inv) {
  $('#freshness').innerHTML =
    `Results through <b>${fmtDate(inv.last_event, { month: 'short', day: 'numeric' })}</b><br>` +
    `Loaded ${fmtDateTime(inv.last_ingest)}`;
}

async function render() {
  const host = $('#view');
  resizeHooks.length = 0;
  host.classList.add('is-stale');
  const fresh = document.createElement('div');
  fresh.className = 'view';
  try {
    await VIEWS[state.view](fresh);
    host.replaceChildren(...fresh.childNodes);
    // Charts were built detached and measured 0px wide; draw them for real now.
    resizeHooks.forEach((fn) => fn());
  } catch (err) {
    host.replaceChildren(node(
      `<section class="panel"><h2>Could not load this view</h2>
       <p class="panel-note">${esc(err.message)}</p>
       <p class="panel-note">Check that the postgres-golf container is running:
       <code>docker compose ps</code></p></section>`));
  } finally {
    host.classList.remove('is-stale');
  }
  if (state.view === 'overview' && state.data['/api/overview']) {
    setFreshness(state.data['/api/overview'].inventory);
  }
}

function initTheme() {
  const stored = localStorage.getItem('clubhouse-theme');
  if (stored) document.documentElement.setAttribute('data-theme', stored);
  const sync = () => {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    $('[data-theme-label]').textContent = dark ? 'Light mode' : 'Dark mode';
  };
  sync();
  $('#theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('clubhouse-theme', next); } catch (e) { /* private mode */ }
    sync();
    resizeHooks.forEach((fn) => fn());
  });
}

function init() {
  initTheme();

  $$('#nav .nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#nav .nav-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      state.view = btn.dataset.view;
      render();
    });
  });

  $('#refresh').addEventListener('click', async () => {
    await fetch('/api/refresh');
    state.data = {};
    render();
  });

  let t;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => resizeHooks.forEach((fn) => fn()), 140);
  });

  render();
}

document.addEventListener('DOMContentLoaded', init);
