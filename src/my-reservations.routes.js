// Rutele pentru pagina „Rezervările mele” (KAN-32 / KAN-35):
// rezervările utilizatorului curent și anularea unei rezervări viitoare.
const express = require('express');
const pool = require('./db');
const { currentUser, UUID_RE } = require('./current-user');

const router = express.Router();
router.use(currentUser);

// Aceleași valori ca în constrângerea CHECK de pe reservations.status.
const STATUSES = [
  'DRAFT', 'PENDING', 'APPROVED', 'REJECTED',
  'CANCELLED', 'ACTIVE', 'COMPLETED', 'EXPIRED',
];
// Doar cererile încă active, care n-au început, se pot anula.
const CANCELLABLE = ['DRAFT', 'PENDING', 'APPROVED'];
const PERIODS = ['upcoming', 'past'];

// O rezervare se poate anula dacă e într-un status din CANCELLABLE și mai
// sunt cel puțin min_cancel_notice_hours ore până la început (regula resursei).
const CAN_CANCEL_SQL = `(rv.status = ANY($2::text[])
  AND rv.start_time > NOW()
    + make_interval(hours => COALESCE(rs.min_cancel_notice_hours, 0)))`;

// Fiecare rezervare vine cu resursa, locația, responsabilul resursei
// și motivul deciziei administratorului (dacă există).
const SELECT_SQL = `SELECT rv.reservation_id, rv.resource_id, rv.start_time,
    rv.end_time, rv.purpose, rv.status, rv.created_at,
    rs.name AS resource_name, rs.type AS resource_type,
    rs.min_cancel_notice_hours, rs.requires_approval,
    TRIM(CONCAT_WS(' ', adm.academic_title, adm.full_name)) AS responsible_name,
    l.building, l.room, l.floor,
    ad.decision, ad.reason AS decision_reason, ad.decided_at,
    ${CAN_CANCEL_SQL} AS can_cancel
  FROM reservations rv
  JOIN resources rs ON rs.resource_id = rv.resource_id
  LEFT JOIN locations l ON l.location_id = rs.location_id
  LEFT JOIN users adm ON adm.user_id = rs.responsible_admin_id
  LEFT JOIN approval_decisions ad ON ad.reservation_id = rv.reservation_id
  WHERE rv.researcher_id = $1`;

function notFound(res) {
  return res.status(404).json({ error: 'Rezervarea nu a fost găsită' });
}

async function findOne(userId, id) {
  const { rows } = await pool.query(
    `${SELECT_SQL} AND rv.reservation_id = $3`,
    [userId, CANCELLABLE, id],
  );
  return rows[0];
}

router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id invalid (trebuie să fie un UUID)' });
  }
  next();
});

// READ (listă). Filtre opționale:
//   ?status=PENDING           doar un anumit status
//   ?period=upcoming | past   viitoare (crescător) / trecute (descrescător)
router.get('/', async (req, res) => {
  const { status = null, period = null } = req.query;
  const errors = [];
  if (status !== null && !STATUSES.includes(status)) {
    errors.push(`status trebuie să fie unul dintre: ${STATUSES.join(', ')}`);
  }
  if (period !== null && !PERIODS.includes(period)) {
    errors.push(`period trebuie să fie unul dintre: ${PERIODS.join(', ')}`);
  }
  if (errors.length) return res.status(400).json({ errors });

  let where = ' AND ($3::text IS NULL OR rv.status = $3)';
  let order = 'rv.start_time DESC';
  if (period === 'upcoming') {
    where += ' AND rv.end_time > NOW()';
    order = 'rv.start_time ASC';
  } else if (period === 'past') {
    where += ' AND rv.end_time <= NOW()';
  }
  const { rows } = await pool.query(
    `${SELECT_SQL}${where} ORDER BY ${order}`,
    [req.userId, CANCELLABLE, status],
  );
  res.json(rows);
});

// READ (una) – doar dacă rezervarea aparține utilizatorului curent.
router.get('/:id', async (req, res) => {
  const row = await findOne(req.userId, req.params.id);
  if (!row) return notFound(res);
  res.json(row);
});

// ANULARE – trece rezervarea în CANCELLED, dacă regulile o permit.
router.patch('/:id/cancel', async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE reservations rv SET status = 'CANCELLED'
     FROM resources rs
     WHERE rs.resource_id = rv.resource_id
       AND rv.researcher_id = $1 AND rv.reservation_id = $3
       AND ${CAN_CANCEL_SQL}`,
    [req.userId, CANCELLABLE, req.params.id],
  );
  const row = await findOne(req.userId, req.params.id);
  if (!row) return notFound(res);
  if (rowCount === 0) {
    return res.status(409).json({ error: cancelRefusal(row) });
  }
  // TODO (KAN-36): notificare CANCELLED pentru administratorul resursei.
  res.json(row);
});

// Explică de ce o rezervare nu poate fi anulată.
function cancelRefusal(row) {
  if (!CANCELLABLE.includes(row.status)) {
    return `Rezervarea are statusul ${row.status} și nu mai poate fi anulată`;
  }
  if (new Date(row.start_time) <= new Date()) {
    return 'Rezervarea a început deja și nu mai poate fi anulată';
  }
  const hours = row.min_cancel_notice_hours;
  const label = hours === 1 ? 'o oră' : `${hours} ore`;
  return `Rezervarea se poate anula cu cel puțin ${label} înainte de început`;
}

module.exports = router;
