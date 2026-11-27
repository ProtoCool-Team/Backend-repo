// KAN-16: regulile unei rezervări, verificate înainte de salvare.
// Fiecare funcție întoarce un mesaj de eroare sau null dacă e totul în regulă.
const pool = require('./db');
// Orarul resurselor (availability_windows) e în ora României (TIME_ZONE).
const { parseReason, TYPE_LABELS, TIME_ZONE } = require('./unavailability');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Citește start_time / end_time din corpul cererii (format ISO 8601).
function parseInterval(body) {
  const start = new Date(body.start_time);
  const end = new Date(body.end_time);
  if (!body.start_time || Number.isNaN(start.getTime())) {
    return { error: 'start_time lipsește sau nu e o dată validă' };
  }
  if (!body.end_time || Number.isNaN(end.getTime())) {
    return { error: 'end_time lipsește sau nu e o dată validă' };
  }
  return { start, end };
}

// Regulile care țin doar de interval și de setările resursei.
function checkBasicRules(resource, start, end, now = new Date()) {
  if (end <= start) return 'Ora de sfârșit trebuie să fie după ora de început';
  if (start <= now) return 'Nu poți rezerva un interval din trecut';
  if (resource.status !== 'AVAILABLE') {
    return 'Resursa este momentan indisponibilă';
  }
  const hours = (end - start) / HOUR_MS;
  if (resource.max_consecutive_hours && hours > resource.max_consecutive_hours) {
    return `Poți rezerva cel mult ${resource.max_consecutive_hours} ore ` +
      'consecutive din această resursă';
  }
  const days = (start - now) / DAY_MS;
  if (resource.max_advance_days && days > resource.max_advance_days) {
    return `Poți rezerva cu cel mult ${resource.max_advance_days} zile ` +
      'în avans';
  }
  return null;
}

// Intervalul trebuie să fie într-o singură zi, în orarul resursei.
// O resursă fără orar definit se poate rezerva oricând.
async function checkSchedule(resourceId, start, end) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS windows,
       COUNT(*) FILTER (
         WHERE w.day_of_week = TRIM(TO_CHAR($2::timestamptz AT TIME ZONE $4, 'FMDAY'))
           AND ($2::timestamptz AT TIME ZONE $4)::date = ($3::timestamptz AT TIME ZONE $4)::date
           AND ($2::timestamptz AT TIME ZONE $4)::time >= w.open_time
           AND ($3::timestamptz AT TIME ZONE $4)::time <= w.close_time
       ) AS matching
     FROM availability_windows w
     WHERE w.resource_id = $1`,
    [resourceId, start, end, TIME_ZONE],
  );
  const { windows, matching } = rows[0];
  if (Number(windows) > 0 && Number(matching) === 0) {
    return 'Intervalul nu se încadrează în programul resursei';
  }
  return null;
}

// Resursa nu se poate rezerva în perioadele de indisponibilitate
// (mentenanță, calibrare, reparații).
async function checkUnavailability(resourceId, start, end) {
  const { rows } = await pool.query(
    `SELECT reason, start_date, end_date FROM unavailability_periods
     WHERE resource_id = $1
       AND start_date <= ($3::timestamptz AT TIME ZONE $4)::date
       AND end_date >= ($2::timestamptz AT TIME ZONE $4)::date
     LIMIT 1`,
    [resourceId, start, end, TIME_ZONE],
  );
  if (!rows.length) return null;
  const { type, details } = parseReason(rows[0].reason);
  const label = TYPE_LABELS[type];
  const note = details ? `${label}: ${details}` : label;
  return `Resursa este indisponibilă în perioada aleasă (${note})`;
}

// Toate regulile KAN-16, în ordine; întoarce primul mesaj de eroare.
async function checkRules(resource, start, end) {
  return checkBasicRules(resource, start, end) ||
    (await checkUnavailability(resource.resource_id, start, end)) ||
    (await checkSchedule(resource.resource_id, start, end));
}

module.exports = { parseInterval, checkRules, checkBasicRules };
