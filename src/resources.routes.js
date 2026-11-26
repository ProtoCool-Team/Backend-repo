const express = require('express');
const { randomUUID } = require('crypto');
const pool = require('./db');
const { adminOnly, ROLES } = require('./current-user');
const { withTransaction } = require('./transaction');

const router = express.Router();

// Aceleași valori ca în constrângerile CHECK din baza de date (rrm_db).
const TYPES = ['ROBOT', 'MEASURING_DEVICE', 'COMPUTE_CLUSTER', 'LAB_ROOM'];
const STATUSES = ['AVAILABLE', 'UNAVAILABLE'];
const NAME_MAX = 150;
const POSITIVE_INT_FIELDS = ['max_consecutive_hours', 'max_advance_days'];
const NON_NEGATIVE_INT_FIELDS = ['min_cancel_notice_hours'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Coloanele editabile și valoarea implicită a fiecăreia (ca în baza de date).
// Ordinea de aici dictează ordinea din toValues și din SQL-ul pentru
// INSERT/UPDATE, deci un câmp nou se adaugă doar aici (și în validare).
const DEFAULTS = {
  name: '',
  description: null,
  type: undefined,
  status: 'AVAILABLE',
  location_id: null,
  responsible_admin_id: null,
  requires_approval: true,
  max_consecutive_hours: null,
  max_advance_days: null,
  min_cancel_notice_hours: null,
  attributes: {},
};
const COLUMNS = Object.keys(DEFAULTS);
const placeholders = (from) => COLUMNS.map((_, i) => `$${i + from}`).join(', ');

const INSERT_SQL = `INSERT INTO resources (resource_id, ${COLUMNS.join(', ')}, created_at)
  VALUES ($1, ${placeholders(2)}, NOW())
  RETURNING resource_id`;
const UPDATE_SQL = `UPDATE resources
  SET ${COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(', ')}
  WHERE resource_id = $${COLUMNS.length + 1}
  RETURNING resource_id`;

// Fiecare resursă e întoarsă împreună cu locația ei (clădire, sală, etaj).
const SELECT_SQL = `SELECT r.*, l.building, l.room, l.floor
  FROM resources r
  LEFT JOIN locations l ON l.location_id = r.location_id`;

async function selectResources(where, params) {
  const { rows } = await pool.query(`${SELECT_SQL} ${where} ORDER BY r.created_at, r.name`, params);
  return rows;
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function notFound(res) {
  return res.status(404).json({ error: 'Resursa nu a fost găsită' });
}

// Completează câmpurile lipsă cu valorile implicite și verifică datele.
function validateResource(body = {}) {
  const resource = Object.fromEntries(COLUMNS.map((c) => [c, body[c] ?? DEFAULTS[c]]));
  resource.name = typeof body.name === 'string' ? body.name.trim() : '';

  const errors = [];
  if (!resource.name) errors.push('name este obligatoriu');
  else if (resource.name.length > NAME_MAX) errors.push(`name poate avea cel mult ${NAME_MAX} de caractere`);
  if (!TYPES.includes(resource.type)) errors.push(`type trebuie să fie unul dintre: ${TYPES.join(', ')}`);
  if (!STATUSES.includes(resource.status)) errors.push(`status trebuie să fie unul dintre: ${STATUSES.join(', ')}`);
  if (typeof resource.requires_approval !== 'boolean') {
    errors.push('requires_approval trebuie să fie true sau false');
  }
  if (!isUuid(resource.location_id)) errors.push('location_id este obligatoriu și trebuie să fie un UUID valid');
  if (resource.responsible_admin_id !== null && !isUuid(resource.responsible_admin_id)) {
    errors.push('responsible_admin_id trebuie să fie un UUID valid');
  }
  for (const field of POSITIVE_INT_FIELDS) {
    const v = resource[field];
    if (v !== null && !(Number.isInteger(v) && v > 0)) errors.push(`${field} trebuie să fie un număr întreg pozitiv`);
  }
  for (const field of NON_NEGATIVE_INT_FIELDS) {
    const v = resource[field];
    if (v !== null && !(Number.isInteger(v) && v >= 0)) errors.push(`${field} trebuie să fie un număr întreg ≥ 0`);
  }
  if (typeof resource.attributes !== 'object' || Array.isArray(resource.attributes)) {
    errors.push('attributes trebuie să fie un obiect JSON');
  }

  return { resource, errors };
}

function toValues(resource) {
  return COLUMNS.map((c) => (c === 'attributes' ? JSON.stringify(resource[c]) : resource[c]));
}

// Orice rută cu :id primește aici verificarea că id-ul e un UUID.
router.param('id', (req, res, next, id) => {
  if (!isUuid(id)) return res.status(400).json({ error: 'id invalid (trebuie să fie un UUID)' });
  next();
});

// READ (listă, cu filtre opționale ?type= și ?status=)
router.get('/', async (req, res) => {
  const { type = null, status = null } = req.query;
  res.json(await selectResources(
    'WHERE ($1::text IS NULL OR r.type = $1) AND ($2::text IS NULL OR r.status = $2)',
    [type, status]
  ));
});

// READ (una)
router.get('/:id', async (req, res) => {
  const [row] = await selectResources('WHERE r.resource_id = $1', [req.params.id]);
  if (!row) return notFound(res);
  res.json(row);
});

// KAN-20: responsabilul unei resurse trebuie să fie administrator.
// FOR SHARE blochează rândul utilizatorului până la sfârșitul tranzacției,
// ca rolul lui să nu poată fi schimbat între verificare și salvare
// (vezi users.routes.js). Întoarce un mesaj de eroare sau null.
async function checkResponsible(client, adminId) {
  if (adminId === null) return null;
  const { rows } = await client.query(
    'SELECT role FROM users WHERE user_id = $1 FOR SHARE',
    [adminId],
  );
  if (!rows.length) return 'responsible_admin_id nu există în baza de date';
  if (rows[0].role !== ROLES.ADMINISTRATOR) {
    return 'Responsabilul resursei trebuie să fie un administrator';
  }
  return null;
}

// CREATE, UPDATE, DELETE – doar administratorii (KAN-20).
// Citirea catalogului rămâne publică (o folosește și pagina de Login).
router.post('/', ...adminOnly, async (req, res) => {
  const { resource, errors } = validateResource(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const result = await withTransaction(async (client) => {
    const error = await checkResponsible(client, resource.responsible_admin_id);
    if (error) return { error };
    const { rows } = await client.query(INSERT_SQL, [randomUUID(), ...toValues(resource)]);
    return { id: rows[0].resource_id };
  });
  if (result.error) return res.status(400).json({ errors: [result.error] });
  const [row] = await selectResources('WHERE r.resource_id = $1', [result.id]);
  res.status(201).json(row);
});

// UPDATE
router.put('/:id', ...adminOnly, async (req, res) => {
  const { resource, errors } = validateResource(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const result = await withTransaction(async (client) => {
    const error = await checkResponsible(client, resource.responsible_admin_id);
    if (error) return { error };
    const { rowCount } = await client.query(UPDATE_SQL, [...toValues(resource), req.params.id]);
    return { found: rowCount > 0 };
  });
  if (result.error) return res.status(400).json({ errors: [result.error] });
  if (!result.found) return notFound(res);
  const [row] = await selectResources('WHERE r.resource_id = $1', [req.params.id]);
  res.json(row);
});

// DELETE (o resursă cu rezervări dă 409, vezi PG_ERRORS din server.js)
router.delete('/:id', ...adminOnly, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM resources WHERE resource_id = $1', [req.params.id]);
  if (rowCount === 0) return notFound(res);
  res.status(204).end();
});

module.exports = router;
