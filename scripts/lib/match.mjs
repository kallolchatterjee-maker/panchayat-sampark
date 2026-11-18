// Best-effort joining of the 2026 booth list (transliterated village labels,
// no LGD codes) to Census village polygons. Blocked by AC number, scored with
// a transliteration-folded edit distance + consonant skeleton.
//
// Coverage is reported, never hidden: every pair lands in
// reports/village-match-report.csv with a score and a status.

const ARTIFACT_TOKEN = /^(a0|b0|m0|mu0|mu|must|m|a|b|0|1|2|3)$/;

const PHONETIC_RULES = [
  [/chh/g, 'c'],
  [/ph/g, 'f'],
  [/gh/g, 'g'],
  [/kh/g, 'k'],
  [/th/g, 't'],
  [/dh/g, 'd'],
  [/bh/g, 'b'],
  [/jh/g, 'j'],
  [/sh/g, 's'],
  [/ch/g, 'c'],
  [/ss/g, 's'],
  [/z/g, 'j'],
  [/w/g, 'v'],
  [/q/g, 'k'],
  [/x/g, 'ks'],
  [/ck/g, 'k'],
  [/y/g, 'i'],
];

export function fold(value) {
  const cleaned = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\((sc|st)\)/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !ARTIFACT_TOKEN.test(token))
    .join(' ');
  let out = cleaned;
  for (const [re, to] of PHONETIC_RULES) out = out.replace(re, to);
  return out.replace(/([a-z])\1+/g, '$1').replace(/\s+/g, ' ').trim();
}

export const skeleton = (value) => fold(value).replace(/[aeiou]/g, '');

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n];
}

const similarity = (a, b) => {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
};

function tokenContained(a, b) {
  const ta = a.split(' ');
  const tb = b.split(' ');
  if (ta.length === 1 && tb.length === 1) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every((token) => long.includes(token));
}

export function scoreName(label, village) {
  const a = label.folded;
  const b = village.folded;
  if (!a || !b) return 0;
  if (a === b) return 1;

  const s1 = similarity(a, b);
  const s2 = similarity(label.skel, village.skel);
  let score = 0.55 * s1 + 0.45 * s2;

  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) {
    score = Math.min(1, score + 0.05);
  } else if (tokenContained(a, b)) {
    score = Math.min(1, score + 0.05);
  }
  return score;
}

export const AUTO_THRESHOLD = 0.86;
export const REVIEW_THRESHOLD = 0.74;

/**
 * @param {Map<number, string[]>} labelsByAc  unique CSV labels per AC
 * @param {Map<number, {id:string,name:string,gp:string|null}[]>} villagesByAc
 */
export function matchVillages(labelsByAc, villagesByAc) {
  const results = new Map(); // ac -> Map<label, match>
  const stats = {
    labels: 0,
    auto: 0,
    review: 0,
    unmatched: 0,
    ambiguous: 0,
    matchedBooths: 0,
    totalBooths: 0,
  };

  for (const [acNo, labels] of labelsByAc) {
    const villages = (villagesByAc.get(acNo) ?? [])
      .map((v) => ({ ...v, folded: fold(v.name), skel: skeleton(v.name) }))
      .filter((v) => v.folded);
    const out = new Map();

    for (const rawLabel of labels) {
      const label = {
        raw: rawLabel,
        folded: fold(rawLabel),
        skel: skeleton(rawLabel),
      };
      stats.labels++;

      if (!label.folded) {
        out.set(rawLabel, { id: null, name: null, score: 0, status: 'unmatched', second: null });
        stats.unmatched++;
        continue;
      }

      let best = null;
      let second = null;
      for (const v of villages) {
        const lengthGap = Math.abs(label.folded.length - v.folded.length);
        if (lengthGap > Math.max(4, 0.5 * Math.max(label.folded.length, v.folded.length))) continue;
        const score = scoreName(label, v);
        if (!best || score > best.score) {
          second = best;
          best = { id: v.id, name: v.name, score, second: null };
        } else if (!second || score > second.score) {
          second = { id: v.id, name: v.name, score };
        }
      }

      if (!best || best.score < REVIEW_THRESHOLD) {
        out.set(rawLabel, {
          id: null,
          name: null,
          score: best?.score ?? 0,
          status: 'unmatched',
          second: second ? { id: second.id, name: second.name, score: second.score } : null,
        });
        stats.unmatched++;
        continue;
      }

      const status = best.score >= AUTO_THRESHOLD ? 'auto' : 'review';
      const ambiguous = Boolean(
        second && second.id !== best.id && best.score - second.score < 0.03,
      );
      if (status === 'auto') stats.auto++;
      else stats.review++;
      if (ambiguous) stats.ambiguous++;

      out.set(rawLabel, {
        id: best.id,
        name: best.name,
        score: Number(best.score.toFixed(3)),
        status,
        ambiguous,
        second: second ? { id: second.id, name: second.name, score: Number(second.score.toFixed(3)) } : null,
      });
    }

    results.set(acNo, out);
  }

  return { results, stats };
}
