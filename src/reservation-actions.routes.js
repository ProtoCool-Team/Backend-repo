// Crearea și prelungirea rezervărilor utilizatorului curent.
//   POST  /api/v1/me/reservations             – rezervare nouă
//   PATCH /api/v1/me/reservations/{id}/extend – prelungește o rezervare
// Fiecare cerere trece prin regulile KAN-16 și verificarea KAN-15.
const express = require('express');
const pool = require('./db');
const { currentUser, UUID_RE } = require('./current-user');
const { OVERLAP_MESSAGE, isFree } = require('./overlap');
const { parseInterval, checkRules } = require('./reservation-rules');
const { findOne } = require('./my-reservations.routes');

const router = express.Router();
router.use(currentUser);

const MAX_PURPOSE = 500;
// Doar rezervările încă active se pot prelungi.
const EXTENDABLE = ['PENDING', 'APPROVED', 'ACTIVE'];

async function loadResource(id) {
  const { rows } = await pool.query(
    'SELECT * FROM resources WHERE resource_id = $1',
    [id],
  );
  return rows[0];
}

// CREATE – rezervare nouă. Statusul depinde de resursă: PENDING dacă
// necesită aprobare, altfel APPROVED direct.
router.post('/', async (req, res) => {
  const { resource_id: resourceId } = req.body;
  const purpose = (req.body.purpose || '').trim();
  if (!UUID_RE.test(resourceId || '')) {
    return res.status(400).json({ error: 'resource_id lipsește sau e invalid' });
  }
  if (purpose.length > MAX_PURPOSE) {
    return res.status(400).json({
      error: `Scopul poate avea cel mult ${MAX_PURPOSE} de caractere`,
    });
  }
  const interval = parseInterval(req.body);
  if (interval.error) return res.status(400).json({ error: interval.error });
  const { start, end } = interval;

  const resource = await loadResource(resourceId);
  if (!resource) return res.status(404).json({ error: 'Resursa nu a fost găsită' });

  const ruleError = await checkRules(resource, start, end);
  if (ruleError) return res.status(422).json({ error: ruleError });
  if (!(await isFree(resourceId, start, end))) {
    return res.status(409).json({ error: OVERLAP_MESSAGE });
  }

  const status = resource.requires_approval ? 'PENDING' : 'APPROVED';
  const { rows } = await pool.query(
    `INSERT INTO reservations
       (resource_id, researcher_id, start_time, end_time, purpose, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING reservation_id`,
    [resourceId, req.userId, start, end, purpose, status],
  );
  // TODO (KAN-36): notificare NEW_REQUEST pentru administratorul resursei.
  res.status(201).json(await findOne(req.userId, rows[0].reservation_id));
});

// PRELUNGIRE – mută ora de sfârșit mai târziu, cu aceleași reguli.
router.patch('/:id/extend', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id invalid (trebuie să fie un UUID)' });
  }
  const current = await findOne(req.userId, id);
  if (!current) {
    return res.status(404).json({ error: 'Rezervarea nu a fost găsită' });
  }
  const newEnd = new Date(req.body.end_time);
  if (!req.body.end_time || Number.isNaN(newEnd.getTime())) {
    return res.status(400).json({ error: 'end_time lipsește sau nu e o dată validă' });
  }
  const oldEnd = new Date(current.end_time);
  if (!EXTENDABLE.includes(current.status) || oldEnd <= new Date()) {
    return res.status(409).json({
      error: 'Doar rezervările active sau viitoare se pot prelungi',
    });
  }
  if (newEnd <= oldEnd) {
    return res.status(400).json({
      error: 'Noua oră de sfârșit trebuie să fie după cea actuală',
    });
  }

  // Regulile se aplică pe toată rezervarea (ex. durata maximă), dar
  // începutul ei poate fi deja în trecut, așa că verificăm de la „acum”.
  const resource = await loadResource(current.resource_id);
  const checkFrom = new Date(Math.max(new Date(current.start_time), Date.now() + 1));
  const ruleError = await checkRules(
    { ...resource, max_consecutive_hours: null },
    checkFrom,
    newEnd,
  ) || maxHoursError(resource, new Date(current.start_time), newEnd);
  if (ruleError) return res.status(422).json({ error: ruleError });
  // Verificăm doar bucata nouă: [sfârșitul vechi, sfârșitul nou).
  if (!(await isFree(current.resource_id, oldEnd, newEnd))) {
    return res.status(409).json({ error: OVERLAP_MESSAGE });
  }

  await pool.query(
    'UPDATE reservations SET end_time = $1 WHERE reservation_id = $2',
    [newEnd, id],
  );
  res.json(await findOne(req.userId, id));
});

// Durata totală după prelungire nu trebuie să depășească limita resursei.
function maxHoursError(resource, start, end) {
  const max = resource.max_consecutive_hours;
  if (max && (end - start) / 3600000 > max) {
    return `Rezervarea poate dura cel mult ${max} ore consecutive`;
  }
  return null;
}

module.exports = router;
