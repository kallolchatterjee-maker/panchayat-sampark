// Progressive enhancement: reveal story cards as they scroll into view and
// animate the headline numbers once when they first appear. Everything stays
// readable without JavaScript; this script only adds the data attributes it
// needs and respects the reader's reduced-motion setting.
(() => {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('IntersectionObserver' in window)) return;

  const nf = new Intl.NumberFormat('en-IN');
  const numberPattern = /\d[\d,]*(?:\.\d+)?/g;
  const hasNumber = /\d/;

  const countTargets = [
    ...document.querySelectorAll([
      '.tiles .tile > b',
      '.team-kpi > b',
      '.summary-kpi > b',
      '.tier-row-total > b',
      '.tier-post > b',
      '.tier-share-total > b',
      '.comp .head > b',
      '.summary-table td',
      '.ward-row > b',
    ].join(',')),
  ].filter((element) => hasNumber.test(element.textContent));

  const revealTargets = [
    ...document.querySelectorAll([
      '.step:not(#hero) > .card',
      '.step:not(#hero) .tiles .tile',
      '.team-kpi',
      '.summary-kpi',
      '.tier-row',
      '.comp',
    ].join(',')),
  ];

  function tokenise(text) {
    return [...text.matchAll(numberPattern)].map((match) => {
      const raw = match[0];
      const decimalPart = raw.split('.')[1] || '';
      return {
        raw,
        index: match.index,
        value: Number(raw.replace(/,/g, '')),
        decimals: decimalPart.length,
        grouped: raw.includes(','),
      };
    }).filter((token) => Number.isFinite(token.value));
  }

  function formatToken(token, value) {
    if (token.decimals) return value.toFixed(token.decimals);
    const rounded = Math.round(value);
    return token.grouped || rounded >= 1000 ? nf.format(rounded) : String(rounded);
  }

  function paint(element, text, tokens, progress) {
    let cursor = 0;
    let output = '';
    for (const token of tokens) {
      output += text.slice(cursor, token.index);
      output += formatToken(token, token.value * progress);
      cursor = token.index + token.raw.length;
    }
    element.textContent = output + text.slice(cursor);
  }

  function animateCount(element, delay) {
    const text = element.textContent;
    const tokens = tokenise(text);
    if (!tokens.length) return;
    element.dataset.count = '';
    paint(element, text, tokens, 0);

    const duration = Math.min(1150, 700 + String(Math.round(tokens[0].value)).length * 80);
    let startedAt;

    function frame(timestamp) {
      if (startedAt === undefined) startedAt = timestamp;
      const elapsed = timestamp - startedAt - delay;
      if (elapsed < 0) {
        requestAnimationFrame(frame);
        return;
      }
      const ratio = Math.min(1, elapsed / duration);
      paint(element, text, tokens, 1 - Math.pow(1 - ratio, 3));
      if (ratio < 1) requestAnimationFrame(frame);
      else element.textContent = text;
    }
    requestAnimationFrame(frame);
  }

  try {
    revealTargets.forEach((element, index) => {
      element.dataset.reveal = '';
      element.style.setProperty('--reveal-delay', `${(index % 5) * 55}ms`);
    });

    const countDelays = new Map(countTargets.map((element, index) => [element, (index % 5) * 45]));

    const revealObserver = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });

    const countObserver = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        animateCount(entry.target, countDelays.get(entry.target) || 0);
      }
    }, { threshold: 0.2, rootMargin: '0px 0px -4% 0px' });

    revealTargets.forEach((element) => revealObserver.observe(element));
    countTargets.forEach((element) => countObserver.observe(element));
  } catch (error) {
    revealTargets.forEach((element) => {
      element.removeAttribute('data-reveal');
      element.classList.add('is-visible');
    });
    countTargets.forEach((element) => {
      delete element.dataset.count;
    });
  }
})();
