const numberFormat = new Intl.NumberFormat('en-IN');

export const num = (value) => numberFormat.format(Math.round(Number(value) || 0));

export const pct = (value, digits = 1) =>
  `${(Number(value) * 100).toFixed(digits)}%`;

export const decimal = (value, digits = 1) =>
  Number(value).toFixed(digits);

export const place = (value) => (value == null || value === '' ? '—' : String(value));
