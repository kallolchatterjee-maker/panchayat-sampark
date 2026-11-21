// Team Appointment showcase. The rows come from Data/Tracker.xlsx sheet 3,
// materialised as public/team-appointments.json by scripts/build-team-data.py.
// The org tree is drawn on a canvas so the reader can pan and zoom instead of
// scrolling a very wide DOM tree horizontally.
(() => {
  const canvas = document.getElementById('team-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const fallback = document.getElementById('team-tree');
  if (!ctx) return;

  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);

  const LABELS = { प्रदेश: 'ज़ोन', ज़ोन: 'ज़िला', ज़िला: 'विधानसभा' };
  const GAP_X = 26;
  const GAP_Y = 18;
  const PAD = 28;
  const MIN_K = 0.05;
  const MAX_K = 2.5;
  const fmt = new Intl.NumberFormat('en-IN');

  let uid = 0;
  const state = {
    root: null,
    nodes: [],
    width: 0,
    height: 0,
    dpr: 1,
    k: 1,
    tx: 0,
    ty: 0,
    hover: null,
    drag: null,
    pinch: null,
    pointers: new Map(),
    colors: null,
    error: '',
  };

  function readColors() {
    const styles = getComputedStyle(document.documentElement);
    const token = (name, fallbackValue) => styles.getPropertyValue(name).trim() || fallbackValue;
    return {
      card: token('--cream', '#f5f2ec'),
      ink: token('--ink', '#121212'),
      orange: token('--or-ink', '#b03a00'),
      mute: token('--mute', '#6b655c'),
      line: token('--line-ui', '#767676'),
      green: token('--green', '#1a8f5a'),
    };
  }

  function makeNode(t, l, parent) {
    return { uid: uid++, t, l, parent, k: new Map(), p: [], open: false, hit: false };
  }

  function buildTree(rows, zoneOrder) {
    const root = makeNode('उत्तर प्रदेश', 'प्रदेश', null);
    const node = (parent, key, label) => {
      if (!parent.k.has(key)) parent.k.set(key, makeNode(key, label, parent));
      return parent.k.get(key);
    };

    for (const row of rows) {
      let target = root;
      if (row.level === 'Zone') {
        target = node(root, row.zone, 'ज़ोन');
      } else if (row.level === 'Vidhan Sabha') {
        target = node(node(node(root, row.zone, 'ज़ोन'), row.zila, 'ज़िला'), row.ac, 'विधानसभा');
      } else if (row.level === 'Zila') {
        target = node(node(root, row.zone, 'ज़ोन'), row.zila, 'ज़िला');
      }
      target.p.push(row);
    }

    const order = zoneOrder.length ? zoneOrder : [...root.k.keys()];
    const rank = (key) => {
      const at = order.indexOf(key);
      return at < 0 ? order.length : at;
    };
    for (const children of [root.k, ...[...root.k.values()].map((zone) => zone.k)]) {
      const entries = [...children.entries()];
      entries.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], 'hi'));
      children.clear();
      for (const [key, value] of entries) children.set(key, value);
    }
    return root;
  }

  function prepare(node, depth) {
    node.depth = depth;
    let appointed = 0;
    let pending = 0;
    let children = 0;
    for (const person of node.p) {
      if (/appoint/i.test(person.status)) appointed += 1;
      else pending += 1;
    }
    for (const child of node.k.values()) {
      const stats = prepare(child, depth + 1);
      appointed += stats.appointed;
      pending += stats.pending;
      children += 1 + stats.children;
    }
    node.stats = { appointed, pending, children };
    node.search = [node.t, ...node.p.map((person) => person.name)].join(' ').toLowerCase();
    node.open = depth <= 1;
    return node.stats;
  }

  function forAll(node, visit) {
    visit(node);
    for (const child of node.k.values()) forAll(child, visit);
  }

  function setOpen(node, open) {
    node.open = open;
    for (const child of node.k.values()) setOpen(child, open);
  }

  function cardSize(depth) {
    return depth === 3 ? { w: 320, h: 112 } : { w: 280, h: 92 };
  }

  function layoutTree() {
    if (!state.root) return;
    const visible = [];

    const measure = (node, depth) => {
      const size = cardSize(depth);
      node.w = size.w;
      node.h = size.h;
      const kids = node.open ? [...node.k.values()] : [];
      for (const kid of kids) measure(kid, depth + 1);

      if (!kids.length) {
        node.boxW = node.w;
        node.boxH = node.h;
        node.x = 0;
        node.y = 0;
        return;
      }

      if (depth === 0) {
        const totalW = kids.reduce((sum, kid) => sum + kid.boxW, 0) + GAP_X * (kids.length - 1);
        const maxH = Math.max(...kids.map((kid) => kid.boxH));
        node.boxW = Math.max(node.w, totalW);
        node.boxH = node.h + GAP_Y + maxH;
        node.x = (node.boxW - node.w) / 2;
        node.y = 0;
        let x = (node.boxW - totalW) / 2;
        for (const kid of kids) {
          kid.ox = x;
          kid.oy = node.h + GAP_Y;
          kid.link = 'down';
          x += kid.boxW + GAP_X;
        }
      } else {
        const totalH = kids.reduce((sum, kid) => sum + kid.boxH, 0) + GAP_Y * (kids.length - 1);
        const maxW = Math.max(...kids.map((kid) => kid.boxW));
        node.boxW = node.w + GAP_X + maxW;
        node.boxH = node.h + GAP_Y + totalH;
        node.x = 0;
        node.y = 0;
        let y = node.h + GAP_Y;
        for (const kid of kids) {
          kid.ox = node.w + GAP_X;
          kid.oy = y;
          kid.link = 'right';
          y += kid.boxH + GAP_Y;
        }
      }
    };

    const place = (node, bx, by) => {
      node.bx = bx;
      node.by = by;
      node.ax = bx + node.x;
      node.ay = by + node.y;
      visible.push(node);
      if (!node.open) return;
      for (const kid of node.k.values()) place(kid, bx + kid.ox, by + kid.oy);
    };

    measure(state.root, 0);
    place(state.root, 0, 0);
    state.nodes = visible;
  }

  function fitText(text, maxWidth) {
    const value = String(text ?? '');
    if (ctx.measureText(value).width <= maxWidth) return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (ctx.measureText(`${value.slice(0, mid)}…`).width <= maxWidth) low = mid;
      else high = mid - 1;
    }
    return `${value.slice(0, low)}…`;
  }

  function verification(row) {
    if (row.verification === 'Verified') return 'सत्यापित';
    if (row.verification === 'Not Verified') return 'असत्यापित';
    return 'सत्यापन: —';
  }

  function duty(row) {
    if (row.dutyInfo === 'हाँ') return 'दायित्व: हाँ';
    if (row.dutyInfo === 'नहीं') return 'दायित्व: नहीं';
    if (row.dutyInfo === 'जानकारी नहीं दी') return 'दायित्व: जानकारी नहीं दी';
    return 'दायित्व: —';
  }

  function personLine(row) {
    return `${row.role ? `${row.role} ` : ''}${row.name} · ${verification(row)} · ${duty(row)}`;
  }

  function chipText(stats) {
    if (!stats.appointed && !stats.pending) return 'डेटा नहीं';
    return stats.pending
      ? `${fmt.format(stats.appointed)} नियुक्त · ${fmt.format(stats.pending)} लंबित`
      : `${fmt.format(stats.appointed)} नियुक्त`;
  }

  function borderColor(depth, colors) {
    if (depth === 1) return '#8a3c0d';
    if (depth === 2) return colors.green;
    if (depth === 3) return colors.mute;
    return colors.orange;
  }

  function drawLinks() {
    const { colors } = state;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1.5;
    for (const node of state.nodes) {
      if (!node.open) continue;
      for (const kid of node.k.values()) {
        if (kid.ox === undefined) continue;
        ctx.beginPath();
        if (kid.link === 'down') {
          const fromX = node.ax + node.w / 2;
          const fromY = node.ay + node.h;
          const toX = kid.ax + kid.w / 2;
          const toY = kid.ay;
          const midY = (fromY + toY) / 2;
          ctx.moveTo(fromX, fromY);
          ctx.lineTo(fromX, midY);
          ctx.lineTo(toX, midY);
          ctx.lineTo(toX, toY);
        } else {
          const fromX = node.ax + node.w;
          const fromY = node.ay + node.h / 2;
          const toX = kid.ax;
          const toY = kid.ay + kid.h / 2;
          const midX = (fromX + toX) / 2;
          ctx.moveTo(fromX, fromY);
          ctx.lineTo(midX, fromY);
          ctx.lineTo(midX, toY);
          ctx.lineTo(toX, toY);
        }
        ctx.stroke();
      }
    }
  }

  function drawCard(node) {
    const { colors, k, tx, ty } = state;
    const x = node.ax;
    const y = node.ay;
    const left = -tx / k;
    const top = -ty / k;
    const right = (state.width - tx) / k;
    const bottom = (state.height - ty) / k;
    if (x > right || x + node.w < left || y > bottom || y + node.h < top) return;

    ctx.fillStyle = colors.card;
    ctx.fillRect(x, y, node.w, node.h);
    ctx.fillStyle = borderColor(node.depth, colors);
    ctx.fillRect(x, y, node.w, 5);

    if (node.hit) {
      ctx.strokeStyle = colors.orange;
      ctx.lineWidth = 3;
      ctx.strokeRect(x - 2, y - 2, node.w + 4, node.h + 4);
    } else if (node === state.hover) {
      ctx.strokeStyle = colors.orange;
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 1, y - 1, node.w + 2, node.h + 2);
    }

    // At overview zoom the labels are unreadable; draw only the card blocks.
    if (state.k < 0.3) return;

    ctx.fillStyle = node.depth >= 2 ? colors.mute : colors.orange;
    ctx.font = '800 10px Poppins, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(fitText(node.l, node.w - 110), x + 12, y + 20);
    if (node.k.size) {
      const toggle = `${node.open ? '−' : '+'} ${node.k.size} ${LABELS[node.l] || ''}`;
      ctx.textAlign = 'right';
      ctx.fillText(fitText(toggle, 92), x + node.w - 12, y + 20);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = colors.ink;
    const titleSize = node.depth === 0 ? 20 : node.depth === 3 ? 14 : 17;
    ctx.font = `700 ${titleSize}px Poppins, sans-serif`;
    ctx.fillText(fitText(node.t, node.w - 24), x + 12, y + 44);

    ctx.font = '600 11px Poppins, sans-serif';
    let lineY = y + 60;
    for (const row of node.p.slice(0, node.depth === 3 ? 3 : 2)) {
      ctx.fillText(fitText(personLine(row), node.w - 24), x + 12, lineY);
      lineY += 14;
    }

    ctx.fillStyle = node.stats.appointed || node.stats.pending ? colors.orange : colors.mute;
    ctx.font = '800 10px Poppins, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fitText(chipText(node.stats), node.w - 24), x + node.w - 12, y + node.h - 8);
    ctx.textAlign = 'left';
  }

  function draw() {
    if (!state.root) return;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.width, state.height);
    if (state.error) {
      ctx.fillStyle = state.colors.orange;
      ctx.font = '700 16px Poppins, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(state.error, state.width / 2, state.height / 2);
      ctx.textAlign = 'left';
      return;
    }
    ctx.save();
    ctx.translate(state.tx, state.ty);
    ctx.scale(state.k, state.k);
    drawLinks();
    for (const node of state.nodes) drawCard(node);
    ctx.restore();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.width = rect.width;
    state.height = rect.height;
    canvas.width = Math.round(rect.width * state.dpr);
    canvas.height = Math.round(rect.height * state.dpr);
    draw();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function fitBounds(minX, minY, maxX, maxY) {
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    state.k = clamp(
      Math.min((state.width - PAD * 2) / width, (state.height - PAD * 2) / height, 1),
      MIN_K,
      MAX_K,
    );
    state.tx = state.width / 2 - ((minX + maxX) / 2) * state.k;
    state.ty = state.height / 2 - ((minY + maxY) / 2) * state.k;
    draw();
  }

  function fit() {
    if (!state.root) return;
    fitBounds(0, 0, state.root.boxW, state.root.boxH);
  }

  function fitNodes(nodes) {
    if (!nodes.length) return;
    fitBounds(
      Math.min(...nodes.map((node) => node.ax)),
      Math.min(...nodes.map((node) => node.ay)),
      Math.max(...nodes.map((node) => node.ax + node.w)),
      Math.max(...nodes.map((node) => node.ay + node.h)),
    );
  }

  function zoomAt(factor, px, py) {
    const next = clamp(state.k * factor, MIN_K, MAX_K);
    const ratio = next / state.k;
    state.tx = px - (px - state.tx) * ratio;
    state.ty = py - (py - state.ty) * ratio;
    state.k = next;
    draw();
  }

  function nodeAt(px, py) {
    const x = (px - state.tx) / state.k;
    const y = (py - state.ty) / state.k;
    for (let index = state.nodes.length - 1; index >= 0; index -= 1) {
      const node = state.nodes[index];
      if (x >= node.ax && x <= node.ax + node.w && y >= node.ay && y <= node.ay + node.h) {
        return node;
      }
    }
    return null;
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function pointerDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function pointerMidpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function updateFallback() {
    if (!fallback || !state.root) return;
    const items = [];
    forAll(state.root, (node) => {
      const people = node.p.map((row) => esc(personLine(row))).join('; ');
      items.push(`<li>${esc(node.l)}: ${esc(node.t)}${people ? ` — ${people}` : ''}</li>`);
    });
    fallback.innerHTML = items.join('');
  }

  function render(data) {
    state.root = buildTree(data.rows || [], data.zoneOrder || []);
    prepare(state.root, 0);
    layoutTree();
    updateFallback();
    fit();
  }

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const position = pointerPosition(event);
    zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, position.x, position.y);
  }, { passive: false });

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    state.pointers.set(event.pointerId, pointerPosition(event));
    if (state.pointers.size === 1) {
      state.drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        tx: state.tx,
        ty: state.ty,
        moved: false,
      };
      canvas.classList.add('dragging');
    } else if (state.pointers.size === 2) {
      const points = [...state.pointers.values()];
      state.pinch = {
        distance: pointerDistance(points[0], points[1]),
        midpoint: pointerMidpoint(points[0], points[1]),
      };
      state.drag = null;
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    if (state.pointers.has(event.pointerId)) {
      state.pointers.set(event.pointerId, pointerPosition(event));
    }
    if (state.pointers.size >= 2 && state.pinch) {
      const points = [...state.pointers.values()];
      const distance = pointerDistance(points[0], points[1]);
      const midpoint = pointerMidpoint(points[0], points[1]);
      if (state.pinch.distance > 0) {
        zoomAt(distance / state.pinch.distance, state.pinch.midpoint.x, state.pinch.midpoint.y);
      }
      state.tx += midpoint.x - state.pinch.midpoint.x;
      state.ty += midpoint.y - state.pinch.midpoint.y;
      state.pinch = { distance, midpoint };
      draw();
      return;
    }
    if (state.drag && event.pointerId === state.drag.pointerId) {
      const dx = event.clientX - state.drag.x;
      const dy = event.clientY - state.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) state.drag.moved = true;
      state.tx = state.drag.tx + dx;
      state.ty = state.drag.ty + dy;
      draw();
      return;
    }
    const position = pointerPosition(event);
    const hover = nodeAt(position.x, position.y);
    if (hover !== state.hover) {
      state.hover = hover;
      draw();
    }
  });

  function endPointer(event, allowClick) {
    const wasClick = allowClick && state.drag && !state.drag.moved &&
      state.drag.pointerId === event.pointerId && state.pointers.size === 1;
    state.pointers.delete(event.pointerId);
    if (state.pointers.size < 2) state.pinch = null;
    if (!state.pointers.size) {
      state.drag = null;
      canvas.classList.remove('dragging');
    }
    if (!wasClick) return;
    const position = pointerPosition(event);
    const node = nodeAt(position.x, position.y);
    if (node && node.k.size) {
      node.open = !node.open;
      layoutTree();
      draw();
    }
  }

  canvas.addEventListener('pointerup', (event) => endPointer(event, true));
  canvas.addEventListener('pointercancel', (event) => endPointer(event, false));
  canvas.addEventListener('pointerleave', () => {
    if (!state.hover) return;
    state.hover = null;
    draw();
  });

  canvas.addEventListener('keydown', (event) => {
    const center = { x: state.width / 2, y: state.height / 2 };
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomAt(1.25, center.x, center.y);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomAt(1 / 1.25, center.x, center.y);
    } else if (event.key === '0') {
      event.preventDefault();
      fit();
    } else if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const step = event.shiftKey ? 120 : 50;
      if (event.key === 'ArrowLeft') state.tx += step;
      if (event.key === 'ArrowRight') state.tx -= step;
      if (event.key === 'ArrowUp') state.ty += step;
      if (event.key === 'ArrowDown') state.ty -= step;
      draw();
    }
  });

  $('team-zoom-in').addEventListener('click', () => zoomAt(1.25, state.width / 2, state.height / 2));
  $('team-zoom-out').addEventListener('click', () => zoomAt(1 / 1.25, state.width / 2, state.height / 2));
  $('team-fit').addEventListener('click', fit);
  $('team-expand').addEventListener('click', () => {
    if (!state.root) return;
    setOpen(state.root, true);
    layoutTree();
    fit();
  });
  $('team-collapse').addEventListener('click', () => {
    if (!state.root) return;
    setOpen(state.root, false);
    state.root.open = true;
    layoutTree();
    fit();
  });
  $('team-search').addEventListener('input', (event) => {
    if (!state.root) return;
    const value = event.target.value.trim().toLowerCase();
    forAll(state.root, (node) => { node.hit = false; });
    if (!value) {
      layoutTree();
      draw();
      return;
    }
    const hits = [];
    forAll(state.root, (node) => {
      if (!node.search.includes(value)) return;
      node.hit = true;
      hits.push(node);
      for (let parent = node.parent; parent; parent = parent.parent) parent.open = true;
    });
    layoutTree();
    if (hits.length) fitNodes(hits);
    else draw();
  });

  window.addEventListener('ps-themechange', () => {
    state.colors = readColors();
    draw();
  });

  state.colors = readColors();
  resize();
  new ResizeObserver(resize).observe(canvas.parentElement || canvas);
  document.fonts?.ready.then(draw);

  fetch('/team-appointments.json')
    .then((response) => {
      if (!response.ok) throw new Error(`team data → ${response.status}`);
      return response.json();
    })
    .then(render)
    .catch(() => {
      state.error = 'डेटा लोड नहीं हो सका।';
      if (fallback) fallback.innerHTML = '<li>डेटा लोड नहीं हो सका।</li>';
      draw();
    });
})();
