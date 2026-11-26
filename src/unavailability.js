// KAN-8: perioade de indisponibilitate (în revizie / defect).
// Tipul și detaliile se păstrează în coloana reason fără a schimba schema:
// '<TYPE>' sau '<TYPE>: <detalii>' (ex. 'DEFECT: Ecran spart').

const UNAVAILABILITY_TYPES = ['IN_REVIEW', 'DEFECT'];

const TYPE_LABELS = {
  IN_REVIEW: 'În revizie',
  DEFECT: 'Defect',
};

// Data curentă în fusul orar al României, pentru comparații cu coloanele DATE.
const TODAY_SQL = "(now() AT TIME ZONE 'Europe/Bucharest')::date";

function encodeReason(type, details) {
  const text = typeof details === 'string' ? details.trim() : '';
  return text ? `${type}: ${text}` : type;
}

function parseReason(reason) {
  if (!reason) return { type: 'IN_REVIEW', details: '' };
  const text = String(reason).trim();
  if (!text) return { type: 'IN_REVIEW', details: '' };
  for (const type of UNAVAILABILITY_TYPES) {
    if (text === type) return { type, details: '' };
    if (text.startsWith(`${type}:`)) {
      return { type, details: text.slice(type.length + 1).trim() };
    }
  }
  // Rânduri vechi fără prefix (ex. 'Calibrare anuală').
  return { type: 'IN_REVIEW', details: text };
}

function toPeriod(row) {
  const { type, details } = parseReason(row.reason);
  return {
    period_id: row.period_id,
    resource_id: row.resource_id,
    type,
    details,
    start_date: row.start_date,
    end_date: row.end_date,
  };
}

module.exports = {
  UNAVAILABILITY_TYPES,
  TYPE_LABELS,
  TODAY_SQL,
  encodeReason,
  parseReason,
  toPeriod,
};
