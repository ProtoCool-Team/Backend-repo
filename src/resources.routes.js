const express = require('express');
const { randomUUID } = require('crypto');
const pool = require('./db');

const router = express.Router();


const TYPES = ['ROBOT', 'MEASURING_DEVICE', 'COMPUTE_CLUSTER', 'LAB_ROOM'];
const UUID_FIELDS = ['location_id', 'responsible_admin_id'];
const POSITIVE_INT_FIELDS = ['max_consecutive_hours', 'max_advance_days', 'min_cancel_notice_hours'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function parseId(req, res) {
  const { id } = req.params;
  if (!isUuid(id)) {
    res.status(400).json({ error: 'id invalid (trebuie să fie un UUID)' });
    return null;
  }
  return id;
}


function readResource(body = {}) {
  const r = {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    description: body.description ?? null,
    type: body.type,
    status: body.status ?? 'AVAILABLE',
    location_id: body.location_id ?? null,
    responsible_admin_id: body.responsible_admin_id ?? null,
    requires_approval: body.requires_approval ?? false,
    max_consecutive_hours: body.max_consecutive_hours ?? null,
    max_advance_days: body.max_advance_days ?? null,
    min_cancel_notice_hours: body.min_cancel_notice_hours ?? null,
    attributes: body.attributes ?? {},
  };

  const errors = [];
  if (!r.name) errors.push('name este obligatoriu');
  if (!TYPES.includes(r.type)) errors.push(`type trebuie să fie unul dintre: ${TYPES.join(', ')}`);
  if (typeof r.status !== 'string' || !r.status.trim()) errors.push('status trebuie să fie un text, de exemplu AVAILABLE');
  if (typeof r.requires_approval !== 'boolean') errors.push('requires_approval trebuie să fie true sau false');
  for (const field of UUID_FIELDS) {
    if (r[field] !== null && !isUuid(r[field])) errors.push(`${field} trebuie să fie un UUID valid`);
  }
  for (const field of POSITIVE_INT_FIELDS) {
    if (r[field] !== null && !isPositiveInt(r[field])) errors.push(`${field} trebuie să fie un număr întreg pozitiv`);
  }
  if (typeof r.attributes !== 'object' || Array.isArray(r.attributes)) {
    errors.push('attributes trebuie să fie un obiect JSON');
  }

  return { r, errors };
}

function toValues(r) {
  return [
    r.name, r.description, r.type, r.status, r.location_id, r.responsible_admin_id,
    r.requires_approval, r.max_consecutive_hours, r.max_advance_days,
    r.min_cancel_notice_hours, JSON.stringify(r.attributes),
  ];
}

// READ 
router.get('/', async (req, res) => {
  const { type = null, status = null } = req.query;
  const { rows } = await pool.query(
    `SELECT * FROM resources
     WHERE ($1::text IS NULL OR type::text = $1)
       AND ($2::text IS NULL OR status::text = $2)
     ORDER BY created_at, name`,
    [type, status]
  );
  res.json(rows);
});

// READ 
router.get('/:id', async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const { rows } = await pool.query('SELECT * FROM resources WHERE resource_id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Resursa nu a fost găsită' });
  res.json(rows[0]);
});

// CREATE 
router.post('/', async (req, res) => {
  const { r, errors } = readResource(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const { rows } = await pool.query(
    `INSERT INTO resources (resource_id, name, description, type, status, location_id,
       responsible_admin_id, requires_approval, max_consecutive_hours, max_advance_days,
       min_cancel_notice_hours, attributes, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     RETURNING *`,
    [randomUUID(), ...toValues(r)]
  );
  res.status(201).json(rows[0]);
});

// UPDATE 
router.put('/:id', async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const { r, errors } = readResource(req.body);
  if (errors.length) return res.status(400).json({ errors });
  const { rows } = await pool.query(
    `UPDATE resources SET name = $1, description = $2, type = $3, status = $4,
       location_id = $5, responsible_admin_id = $6, requires_approval = $7,
       max_consecutive_hours = $8, max_advance_days = $9, min_cancel_notice_hours = $10,
       attributes = $11
     WHERE resource_id = $12
     RETURNING *`,
    [...toValues(r), id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Resursa nu a fost găsită' });
  res.json(rows[0]);
});

// DELETE
router.delete('/:id', async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM resources WHERE resource_id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Resursa nu a fost găsită' });
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Resursa nu poate fi ștearsă: are rezervări sau alte date asociate' });
    }
    throw err;
  }
});

module.exports = router;