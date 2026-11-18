// RFC-4180 CSV reader + booth-list loader.
// The source file is quoted properly, but several booth names contain commas,
// so splitting on "," corrupts ~4.4k rows. Parse the quotes.
import { readFileSync } from 'node:fs';

export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Normalises the corrupted 7th header ("????? ????? ...") and returns booth rows.
export function loadBooths(csvPath) {
  const text = readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  const header = rows.shift().map((h) => h.trim());
  header[6] = 'Village (English Transliterated Name)';

  const booths = [];
  for (const row of rows) {
    if (!row.length || row.every((v) => !v.trim())) continue;
    if (row.length !== 7) {
      throw new Error(`Unexpected CSV row with ${row.length} fields: ${JSON.stringify(row)}`);
    }
    const [state, acNo, acName, boothNo, boothName, boothLabel, villageLabel] = row;
    const no = Number(acNo);
    if (!Number.isFinite(no)) throw new Error(`Bad AC number: ${acNo}`);
    booths.push({
      state: state.trim(),
      acNo: no,
      acName: acName.trim(),
      boothNo: Number(boothNo),
      boothName: boothName.trim(),
      boothLabel: boothLabel.trim(),
      villageLabel: villageLabel.trim(),
    });
  }
  return { header, booths };
}
