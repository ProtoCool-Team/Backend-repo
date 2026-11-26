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
const { withTransaction } = require('./transaction');

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

// Verificările și schimbarea rolului, în aceeași tranzacție. Întoarce
// {status, error} dacă schimbarea nu e permisă, altfel {user}.
async function changeRole(client, id, role) {
  // Blocăm toți administratorii și utilizatorul ales, ca două cereri
  // simultane (ex. doi administratori care se retrogradează reciproc) să
  // fie tratate pe rând.
  const { rows: admins } = await client.query(
    `SELECT user_id FROM users
     WHERE role = $1 OR user_id = $2
     ORDER BY user_id
     FOR UPDATE`,
    [ROLES.ADMINISTRATOR, id],
  );
  const { rows: found } = await client.query(
    'SELECT role FROM users WHERE user_id = $1',
    [id],
  );
  if (!found.length) {
    return { status: 404, error: 'Utilizatorul nu a fost găsit' };
  }

  if (found[0].role === ROLES.ADMINISTRATOR && role === ROLES.RESEARCHER) {
    const adminCount = admins.filter((a) => a.user_id !== id).length + 1;
    if (adminCount <= 1) {
      return {
        status: 409,
        error: 'Platforma trebuie să aibă cel puțin un administrator.',
      };
    }
    // Un administrator responsabil de resurse nu poate deveni cercetător
    // până nu se mută resursele la alt responsabil. Rândul lui e blocat,
    // deci nimeni nu-i poate atribui o resursă între timp (vezi
    // resources.routes.js, care citește responsabilul cu FOR SHARE).
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM resources WHERE responsible_admin_id = $1',
      [id],
    );
    if (rows[0].n > 0) {
      return {
        status: 409,
        error: `Utilizatorul este responsabil de ${rows[0].n} resurse. ` +
          'Alege alt responsabil pentru ele înainte de a-i schimba rolul.',
      };
    }
  }

  const { rows } = await client.query(
    `UPDATE users SET role = $1 WHERE user_id = $2 RETURNING ${FIELDS}`,
    [role, id],
  );
  return { user: rows[0] };
}

router.patch('/:id/role', async (req, res) => {
  const { role } = req.body || {};
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'id invalid (trebuie să fie un UUID)' });
  }
  // UUID-urile pot veni cu litere mari; Postgres le compară fără să țină
  // cont de asta, deci le comparăm la fel.
  const id = req.params.id.toLowerCase();
  if (!Object.values(ROLES).includes(role)) {
    return res.status(400).json({
      error: `role trebuie să fie unul dintre: ${Object.values(ROLES).join(', ')}`,
    });
  }
  if (id === String(req.userId).toLowerCase()) {
    return res.status(409).json({ error: 'Nu îți poți schimba propriul rol.' });
  }

  const result = await withTransaction((client) => changeRole(client, id, role));
  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }
  res.json(result.user);
});

module.exports = router;
