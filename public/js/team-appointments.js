// Team Appointment showcase. The rows come from Data/Tracker.xlsx sheet 3,
// materialised as public/team-appointments.json by scripts/build-team-data.py.
// The shape mirrors the reference org tree: Pradesh → Zone → Zila → Vidhan Sabha.
(() => {
  const tree = document.getElementById('team-tree');
  if (!tree) return;

  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);

  const LABELS = { प्रदेश: 'ज़ोन', ज़ोन: 'ज़िला', ज़िला: 'विधानसभा' };
  const LEVEL_TITLE = { Pradesh: 'प्रदेश', Zone: 'ज़ोन', Zila: 'ज़िला', 'Vidhan Sabha': 'विधानसभा' };

  function buildTree(rows, zoneOrder) {
    const root = { t: 'उत्तर प्रदेश', l: 'प्रदेश', k: new Map(), p: [] };
    const node = (parent, key, label) => {
      if (!parent.k.has(key)) parent.k.set(key, { t: key, l: label, k: new Map(), p: [] });
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

    // Keep the tracker's zone order, then sort the rest alphabetically.
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

  function count(node) {
    const own = { a: 0, w: 0 };
    for (const person of node.p) {
      if (/appoint/i.test(person.status)) own.a += 1;
      else own.w += 1;
    }
    let children = 0;
    for (const child of node.k.values()) {
      const sub = count(child);
      own.a += sub.a;
      own.w += sub.w;
      children += 1 + sub.children;
    }
    return { ...own, children };
  }

  function statusBadges(row) {
    const verified = row.verification === 'Verified'
      ? { label: 'सत्यापित', cls: 'verified' }
      : row.verification === 'Not Verified'
        ? { label: 'असत्यापित', cls: 'unverified' }
        : { label: 'सत्यापन: —', cls: 'unknown' };
    const duty = row.dutyInfo === 'हाँ'
      ? { label: 'दायित्व: हाँ', cls: 'duty-yes' }
      : row.dutyInfo === 'नहीं'
        ? { label: 'दायित्व: नहीं', cls: 'duty-no' }
        : row.dutyInfo === 'जानकारी नहीं दी'
          ? { label: 'दायित्व: जानकारी नहीं दी', cls: 'unknown' }
          : { label: 'दायित्व: —', cls: 'unknown' };
    return `<div class="team-person-meta">
      <span class="team-badge team-badge-${verified.cls}">${verified.label}</span>
      <span class="team-badge team-badge-${duty.cls}">${duty.label}</span>
    </div>`;
  }

  function personHtml(row) {
    const title = [row.designation, row.verification, `दायित्व: ${row.dutyInfo || '—'}`, row.mobile && `मो: ${row.mobile}`]
      .filter(Boolean).join(' · ');
    const role = row.role
      ? `<span class="team-role${/सह/.test(row.role) ? ' team-role-sub' : ''}">${esc(row.role)}</span>`
      : '';
    const designation = row.designation ? `<small>${esc(row.designation)}</small>` : '';
    return `<div class="team-person"${title ? ` title="${esc(title)}"` : ''}>
      <div class="team-person-name">${role}${esc(row.name)}</div>
      ${designation}
      ${statusBadges(row)}
    </div>`;
  }

  function nodeHtml(node, depth, stats) {
    const counts = stats.get(node) || count(node);
    const kids = [...node.k.values()];
    const statusClass = counts.a ? '' : counts.w ? ' team-chip-wait' : ' team-chip-none';
    const chip = counts.a || counts.w
      ? `<span class="team-chip${statusClass}">${counts.a} नियुक्त${counts.w ? ` · ${counts.w} लंबित` : ''}</span>`
      : '<span class="team-chip team-chip-none">डेटा नहीं</span>';
    const toggle = kids.length
      ? `<span class="team-toggle" aria-hidden="true">${kids.length} ${LABELS[node.l] || ''}</span>`
      : '';
    const search = [node.t, ...node.p.map((person) => person.name)].join(' ').toLowerCase();
    // Start at Pradesh → six zones; deeper levels open on demand.
    const open = depth === 0 ? ' open' : '';
    const buttonAttrs = kids.length ? ' role="button" tabindex="0"' : '';
    const childList = kids.length
      ? `<ul class="team-children${node.l === 'ज़िला' ? ' team-children-vert' : ''}">${kids
          .map((child) => nodeHtml(child, depth + 1, stats)).join('')}</ul>`
      : '';

    return `<li class="team-node${open}" data-s="${esc(search)}">
      <div class="team-node-card team-l${depth}"${buttonAttrs}>
        <div class="team-node-label">${esc(node.l)}</div>
        <div class="team-node-title">${esc(node.t)}</div>
        <div class="team-people">${node.p.map(personHtml).join('')}</div>
        <div class="team-node-foot">${chip}${toggle}</div>
      </div>
      ${childList}
    </li>`;
  }

  function render(data) {
    const root = buildTree(data.rows || [], data.zoneOrder || []);
    const stats = new Map();
    const collect = (node) => {
      stats.set(node, count(node));
      for (const child of node.k.values()) collect(child);
    };
    collect(root);
    tree.innerHTML = nodeHtml(root, 0, stats);
  }

  function toggle(li) {
    const card = li?.querySelector(':scope > .team-node-card');
    if (card?.getAttribute('role') === 'button') li.classList.toggle('open');
  }

  tree.addEventListener('click', (event) => {
    toggle(event.target.closest('.team-node'));
  });
  tree.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.team-node-card');
    if (!card || card.getAttribute('role') !== 'button') return;
    event.preventDefault();
    toggle(card.parentElement);
  });

  $('team-expand').addEventListener('click', () => {
    tree.querySelectorAll('.team-node').forEach((li) => li.classList.add('open'));
  });
  $('team-collapse').addEventListener('click', () => {
    tree.querySelectorAll('.team-node').forEach((li, index) => {
      if (index) li.classList.remove('open');
    });
  });

  $('team-search').addEventListener('input', (event) => {
    const value = event.target.value.trim().toLowerCase();
    tree.querySelectorAll('.team-hit').forEach((node) => node.classList.remove('team-hit'));
    if (!value) return;
    tree.querySelectorAll('.team-node').forEach((li) => {
      if (!(li.dataset.s || '').includes(value)) return;
      li.querySelector(':scope > .team-node-card')?.classList.add('team-hit');
      let parent = li.parentElement?.closest('.team-node');
      while (parent) {
        parent.classList.add('open');
        parent = parent.parentElement?.closest('.team-node');
      }
    });
  });

  const scriptParams = new URLSearchParams(document.currentScript?.src.split('?')[1] || '');
  const dataVersion = scriptParams.get('v') || scriptParams.get('ui') || '';
  const teamDataUrl = `/team-appointments.json${dataVersion ? `?v=${encodeURIComponent(dataVersion)}` : ''}`;

  // Build the large tree only when the section is close to the viewport. The
  // reserved min-height in CSS keeps the scroll position stable while loading.
  tree.innerHTML = '<li class="team-loading">टीम संरचना लोड हो रही है…</li>';
  let started = false;

  function animateTree() {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !window.gsap) return;
    const cards = tree.querySelectorAll(':scope > li > .team-node-card');
    if (cards.length) {
      window.gsap.from(cards, {
        opacity: 0,
        y: 18,
        duration: 0.6,
        stagger: 0.07,
        ease: 'power3.out',
        clearProps: 'opacity,transform',
      });
    }
  }

  function loadTree() {
    if (started) return;
    started = true;
    fetch(teamDataUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`team data → ${response.status}`);
        return response.json();
      })
      .then((data) => {
        render(data);
        animateTree();
      })
      .catch(() => {
        tree.innerHTML = '<li class="team-error">डेटा लोड नहीं हो सका।</li>';
      });
  }

  // ScrollTrigger fetches the tree before the section arrives, so the lazy
  // DOM build never happens in the middle of the team/summaries transition.
  const section = tree.closest('.step') || tree;
  const hasScrollTrigger =
    typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';

  if (hasScrollTrigger) {
    window.gsap.registerPlugin(window.ScrollTrigger);
    window.ScrollTrigger.create({
      trigger: section,
      start: 'top bottom+=900',
      once: true,
      onEnter: loadTree,
    });
    if (section.getBoundingClientRect().top < window.innerHeight + 900) loadTree();
  } else if ('IntersectionObserver' in window) {
    const loader = new IntersectionObserver(
      (entries, observer) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        loadTree();
      },
      { rootMargin: '900px 0px' },
    );
    loader.observe(section);
  } else {
    loadTree();
  }
})();
