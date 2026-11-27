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
  TODAY_SQL,
  encodeReason,
  toPeriod,
} = require('./unavailability');

const router = express.Router({ mergeParams: true });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DETAILS_MAX = 200;
const FORBIDDEN_ERROR = 'Doar administratorii pot face această operație.';

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

function validateResourceId(req, res, next) {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'id invalid (trebuie să fie un UUID)' });
  }
  next();
}

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
  const exists = await pool.query(
    'SELECT 1 FROM resources WHERE resource_id = $1',
    [id],
  );
  if (!exists.rowCount) {
    return res.status(404).json({ error: 'Resursa nu a fost găsită' });
  }

  const { rows } = await pool.query(
    `SELECT
       period_id,
       resource_id,
       to_char(start_date, 'YYYY-MM-DD') AS start_date,
       to_char(end_date, 'YYYY-MM-DD') AS end_date,
       reason
     FROM unavailability_periods
     WHERE resource_id = $1
       AND end_date >= ${TODAY_SQL}
     ORDER BY start_date`,
    [id],
  );
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
    const resource = await client.query(
      'SELECT 1 FROM resources WHERE resource_id = $1 FOR UPDATE',
      [id],
    );
    if (!resource.rowCount) {
      return { status: 404, error: 'Resursa nu a fost găsită' };
    }

    if (!(await callerStillAdmin(client, req.userId))) {
      return { status: 403, error: FORBIDDEN_ERROR };
    }

    const { rows: [dateCheck] } = await client.query(
      `SELECT ($1::date < ${TODAY_SQL}) AS in_past`,
      [start_date],
    );
    if (dateCheck.in_past) {
      return { status: 400, errors: ['Perioada nu poate începe în trecut'] };
    }

    const { rows: overlapping } = await client.query(
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
    if (overlapping.length) {
      const other = overlapping[0];
      return {
        status: 409,
        error: `Se suprapune cu o altă perioadă de indisponibilitate (${other.start_date} – ${other.end_date})`,
      };
    }

    const { rows: [inserted] } = await client.query(
      `INSERT INTO unavailability_periods (resource_id, start_date, end_date, reason)
       VALUES ($1, $2::date, $3::date, $4)
       RETURNING
         period_id,
         resource_id,
         to_char(start_date, 'YYYY-MM-DD') AS start_date,
         to_char(end_date, 'YYYY-MM-DD') AS end_date,
         reason`,
      [id, start_date, end_date, encodeReason(type, details)],
    );

    // Rezervările care nu s-au încheiat încă și cad în perioadă.
    // TODO: rezervările afectate nu sunt anulate automat aici; notificările
    // pentru utilizatorii afectați vor fi implementate într-un tichet ulterior.
    const { rows: affectedReservations } = await client.query(
      `SELECT reservation_id, start_time, end_time, status
       FROM reservations
       WHERE resource_id = $1
         AND status = ANY($4::text[])
         AND end_time > now()
         AND tstzrange(start_time, end_time, '[)') && tstzrange(
           ($2::date)::timestamp AT TIME ZONE 'Europe/Bucharest',
           (($3::date) + 1)::timestamp AT TIME ZONE 'Europe/Bucharest',
           '[)'
         )
       ORDER BY start_time`,
      [id, start_date, end_date, BLOCKING],
    );

    return {
      status: 201,
      period: toPeriod(inserted),
      affected_reservations: affectedReservations,
    };
  });

  if (result.errors) return res.status(result.status).json({ errors: result.errors });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json({
    period: result.period,
    affected_reservations: result.affected_reservations,
  });
});

// Șterge o perioadă viitoare sau încheie mai devreme una aflată în desfășurare.
router.delete('/:periodId', ...adminOnly, validateResourceId, async (req, res) => {
  const { id, periodId } = req.params;
  if (!UUID_RE.test(periodId)) {
    return res.status(400).json({ error: 'periodId invalid (trebuie să fie un UUID)' });
  }

  const result = await withTransaction(async (client) => {
    if (!(await callerStillAdmin(client, req.userId))) {
      return { status: 403, error: FORBIDDEN_ERROR };
    }

    const { rows } = await client.query(
      `SELECT
         period_id,
         (start_date >= ${TODAY_SQL}) AS is_future_or_today,
         (end_date < ${TODAY_SQL}) AS is_ended
       FROM unavailability_periods
       WHERE period_id = $1 AND resource_id = $2
       FOR UPDATE`,
      [periodId, id],
    );
    if (!rows.length) {
      const resource = await client.query(
        'SELECT 1 FROM resources WHERE resource_id = $1',
        [id],
      );
      if (!resource.rowCount) {
        return { status: 404, error: 'Resursa nu a fost găsită' };
      }
      return { status: 404, error: 'Perioada nu a fost găsită' };
    }

    const period = rows[0];
    if (period.is_future_or_today) {
      await client.query(
        'DELETE FROM unavailability_periods WHERE period_id = $1',
        [periodId],
      );
      return { status: 204 };
    }
    if (period.is_ended) {
      return { status: 409, error: 'Perioada s-a încheiat deja' };
    }

    const { rows: [updated] } = await client.query(
      `UPDATE unavailability_periods
       SET end_date = (${TODAY_SQL} - 1)
       WHERE period_id = $1
       RETURNING
         period_id,
         resource_id,
         to_char(start_date, 'YYYY-MM-DD') AS start_date,
         to_char(end_date, 'YYYY-MM-DD') AS end_date,
         reason`,
      [periodId],
    );
    return { status: 200, period: toPeriod(updated) };
  });

  if (result.error) return res.status(result.status).json({ error: result.error });
  if (result.status === 204) return res.status(204).end();
  res.json(result.period);
});

module.exports = router;
