// KAN-15: ocuparea unei resurse, pentru calendarul din ecranul „Rezervare”.
// GET /api/v1/resources/{id}/reservations?from=...&to=...
// Întoarce doar intervalele ocupate (fără datele altor cercetători),
// iar is_mine arată care sunt ale utilizatorului curent.
const express = require('express');
const pool = require('./db');
const { currentUser, UUID_RE } = require('./current-user');
const { BLOCKING } = require('./overlap');

const router = express.Router({ mergeParams: true });
router.use(currentUser);

const MAX_RANGE_DAYS = 62;

router.get('/', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id invalid (trebuie să fie un UUID)' });
  }
  const from = new Date(req.query.from);
  const to = new Date(req.query.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    return res.status(400).json({
      error: 'Trimiteți from și to (date ISO), cu to după from',
    });
  }
  if ((to - from) / 86400000 > MAX_RANGE_DAYS) {
    return res.status(400).json({
      error: `Intervalul cerut poate avea cel mult ${MAX_RANGE_DAYS} de zile`,
    });
  }

  const exists = await pool.query(
    'SELECT 1 FROM resources WHERE resource_id = $1',
    [id],
  );
  if (!exists.rowCount) {
    return res.status(404).json({ error: 'Resursa nu a fost găsită' });
  }

  const { rows } = await pool.query(
    `SELECT start_time, end_time, status, (researcher_id = $4) AS is_mine
     FROM reservations
     WHERE resource_id = $1
       AND status = ANY($5::text[])
       AND tstzrange(start_time, end_time, '[)') && tstzrange($2, $3, '[)')
     ORDER BY start_time`,
    [id, from, to, req.userId, BLOCKING],
  );
  res.json(rows);
});

module.exports = router;
