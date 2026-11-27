// KAN-8: administrarea perioadelor de indisponibilitate ale unei resurse.
// Montat la /api/v1/resources/:id/unavailability.
const express = require('express');
const pool = require('./db');
const {
  currentUser,
  adminOnly,
  callerStillAdmin,
  UUID_RE,
} = require('./current-user');
const { withTransaction } = require('./transaction');
const { BLOCKING } = require('./overlap');
const {
  UNAVAILABILITY_TYPES,
  TIME_ZONE,
  TODAY_SQL,
  PERIOD_COLUMNS,
  encodeReason,
  toPeriod,
} = require('./unavailability');

const router = express.Router({ mergeParams: true });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DETAILS_MAX = 200;

// Rezultatele tranzacțiilor au forma { status, body } (fără body = 204).
const FORBIDDEN = {
  status: 403,
  body: { error: 'Doar administratorii pot face această operație.' },
};
const RESOURCE_NOT_FOUND = { status: 404, body: { error: 'Resursa nu a fost găsită' } };

function send(res, { status, body }) {
  return body ? res.status(status).json(body) : res.status(status).end();
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

// :id vine din montarea părintelui (mergeParams), așa că router.param('id')
// nu se declanșează aici; îl verificăm pe fiecare rută, după autentificare.
function validateResourceId(req, res, next) {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'id invalid (trebuie să fie un UUID)' });
  }
  next();
}

router.param('periodId', (req, res, next, periodId) => {
  if (!UUID_RE.test(periodId)) {
    return res.status(400).json({ error: 'periodId invalid (trebuie să fie un UUID)' });
  }
  next();
});

function validatePeriodBody(body = {}) {
  const errors = [];
  const { type, start_date, end_date, details } = body;

  if (!UNAVAILABILITY_TYPES.includes(type)) {
    errors.push('type trebuie să fie IN_REVIEW sau DEFECT');
  }

  const startValid = isValidDateString(start_date);
  const endValid = isValidDateString(end_date);
  if (!startValid) {
    errors.push('start_date trebuie să fie o dată validă (YYYY-MM-DD)');
  }
  if (!endValid) {
    errors.push('end_date trebuie să fie o dată validă (YYYY-MM-DD)');
  }
  if (startValid && endValid && end_date < start_date) {
    errors.push('Data de sfârșit nu poate fi înainte de data de început');
  }

  if (details !== undefined && details !== null) {
    if (typeof details !== 'string') {
      errors.push('details trebuie să fie text');
    } else if (details.trim().length > DETAILS_MAX) {
      errors.push(`details poate avea cel mult ${DETAILS_MAX} de caractere`);
    }
  }

  return errors;
}

// Perioadele curente și viitoare ale unei resurse.
router.get('/', currentUser, validateResourceId, async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT ${PERIOD_COLUMNS}
     FROM unavailability_periods
     WHERE resource_id = $1
       AND end_date >= ${TODAY_SQL}
     ORDER BY start_date`,
    [id],
  );
  // O listă goală poate însemna și o resursă inexistentă.
  if (!rows.length) {
    const exists = await pool.query(
      'SELECT 1 FROM resources WHERE resource_id = $1',
      [id],
    );
    if (!exists.rowCount) return send(res, RESOURCE_NOT_FOUND);
  }
  res.json(rows.map(toPeriod));
});

// Adaugă o perioadă de indisponibilitate (doar administratori).
router.post('/', ...adminOnly, validateResourceId, async (req, res) => {
  const body = req.body || {};
  const errors = validatePeriodBody(body);
  if (errors.length) return res.status(400).json({ errors });

  const { id } = req.params;
  const { type, start_date, end_date, details } = body;

  const result = await withTransaction(async (client) => {
    if (!(await callerStillAdmin(client, req.userId))) return FORBIDDEN;

    // FOR UPDATE serializează adăugările simultane pentru aceeași resursă.
    const { rows: [resource] } = await client.query(
      `SELECT ($2::date < ${TODAY_SQL}) AS in_past
       FROM resources WHERE resource_id = $1 FOR UPDATE`,
      [id, start_date],
    );
    if (!resource) return RESOURCE_NOT_FOUND;
    if (resource.in_past) {
      return { status: 400, body: { errors: ['Perioada nu poate începe în trecut'] } };
    }

    const { rows: [other] } = await client.query(
      `SELECT
         to_char(start_date, 'YYYY-MM-DD') AS start_date,
         to_char(end_date, 'YYYY-MM-DD') AS end_date
       FROM unavailability_periods
       WHERE resource_id = $1
         AND start_date <= $3::date
         AND end_date >= $2::date
       ORDER BY start_date
       LIMIT 1`,
      [id, start_date, end_date],
    );
    if (other) {
      return {
        status: 409,
        body: {
          error: `Se suprapune cu o altă perioadă de indisponibilitate (${other.start_date} – ${other.end_date})`,
        },
      };
    }

    const { rows: [inserted] } = await client.query(
      `INSERT INTO unavailability_periods (resource_id, start_date, end_date, reason)
       VALUES ($1, $2::date, $3::date, $4)
       RETURNING ${PERIOD_COLUMNS}`,
      [id, start_date, end_date, encodeReason(type, details)],
    );

    // Rezervările care nu s-au încheiat încă și cad în perioadă.
    // TODO: rezervările afectate nu sunt anulate automat aici; notificările
    // pentru utilizatorii afectați vor fi implementate într-un tichet ulterior.
    const { rows: affected } = await client.query(
      `SELECT reservation_id, start_time, end_time, status
       FROM reservations
       WHERE resource_id = $1
         AND status = ANY($4::text[])
         AND end_time > now()
         AND tstzrange(start_time, end_time, '[)') && tstzrange(
           ($2::date)::timestamp AT TIME ZONE $5,
           (($3::date) + 1)::timestamp AT TIME ZONE $5,
           '[)'
         )
       ORDER BY start_time`,
      [id, start_date, end_date, BLOCKING, TIME_ZONE],
    );

    return {
      status: 201,
      body: { period: toPeriod(inserted), affected_reservations: affected },
    };
  });

  send(res, result);
});

// Șterge o perioadă viitoare sau încheie mai devreme una aflată în desfășurare.
router.delete('/:periodId', ...adminOnly, validateResourceId, async (req, res) => {
  const { id, periodId } = req.params;

  const result = await withTransaction(async (client) => {
    if (!(await callerStillAdmin(client, req.userId))) return FORBIDDEN;

    const { rows: [period] } = await client.query(
      `SELECT
         (start_date >= ${TODAY_SQL}) AS is_future_or_today,
         (end_date < ${TODAY_SQL}) AS is_ended
       FROM unavailability_periods
       WHERE period_id = $1 AND resource_id = $2
       FOR UPDATE`,
      [periodId, id],
    );
    if (!period) {
      const resource = await client.query(
        'SELECT 1 FROM resources WHERE resource_id = $1',
        [id],
      );
      if (!resource.rowCount) return RESOURCE_NOT_FOUND;
      return { status: 404, body: { error: 'Perioada nu a fost găsită' } };
    }

    if (period.is_future_or_today) {
      await client.query(
        'DELETE FROM unavailability_periods WHERE period_id = $1',
        [periodId],
      );
      return { status: 204 };
    }
    if (period.is_ended) {
      return { status: 409, body: { error: 'Perioada s-a încheiat deja' } };
    }

    const { rows: [updated] } = await client.query(
      `UPDATE unavailability_periods
       SET end_date = (${TODAY_SQL} - 1)
       WHERE period_id = $1
       RETURNING ${PERIOD_COLUMNS}`,
      [periodId],
    );
    return { status: 200, body: toPeriod(updated) };
  });

  send(res, result);
});

module.exports = router;
