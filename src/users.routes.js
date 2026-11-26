// KAN-20: administrarea conturilor și a rolurilor (doar administratori).
//   GET   /api/v1/users           – lista utilizatorilor
//   PATCH /api/v1/users/{id}/role – schimbă rolul: {"role": "ADMINISTRATOR"}
//
// Roluri (constrângerea users_role_check din baza de date):
//   RESEARCHER    – student / cercetător: caută resurse și rezervă
//   ADMINISTRATOR – cadru didactic / responsabil de laborator: administrează
const express = require('express');
const pool = require('./db');
const { adminOnly, ROLES, UUID_RE } = require('./current-user');

const router = express.Router();
router.use(...adminOnly);

const FIELDS = `user_id, full_name, email, role, department, laboratory,
  academic_title, created_at`;

router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${FIELDS} FROM users ORDER BY role, full_name`,
  );
  res.json(rows);
});

router.patch('/:id/role', async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id invalid (trebuie să fie un UUID)' });
  }
  if (!Object.values(ROLES).includes(role)) {
    return res.status(400).json({
      error: `role trebuie să fie unul dintre: ${Object.values(ROLES).join(', ')}`,
    });
  }
  // Așa nu rămâne platforma fără niciun administrator.
  if (id === req.userId) {
    return res.status(409).json({ error: 'Nu îți poți schimba propriul rol.' });
  }

  const { rows: found } = await pool.query(
    'SELECT role FROM users WHERE user_id = $1',
    [id],
  );
  if (!found.length) {
    return res.status(404).json({ error: 'Utilizatorul nu a fost găsit' });
  }

  // Un administrator responsabil de resurse nu poate deveni cercetător
  // până nu se mută resursele la alt responsabil.
  if (found[0].role === ROLES.ADMINISTRATOR && role === ROLES.RESEARCHER) {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM resources WHERE responsible_admin_id = $1',
      [id],
    );
    if (rows[0].n > 0) {
      return res.status(409).json({
        error: `Utilizatorul este responsabil de ${rows[0].n} resurse. ` +
          'Alege alt responsabil pentru ele înainte de a-i schimba rolul.',
      });
    }
  }

  const { rows } = await pool.query(
    `UPDATE users SET role = $1 WHERE user_id = $2 RETURNING ${FIELDS}`,
    [role, id],
  );
  res.json(rows[0]);
});

module.exports = router;
