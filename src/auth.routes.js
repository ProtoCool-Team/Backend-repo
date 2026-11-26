// KAN-19: autentificare.
//   POST /api/v1/auth/login    – email + parolă → token + utilizator
//   POST /api/v1/auth/register – cont nou de cercetător → token + utilizator
//   GET  /api/v1/auth/me       – utilizatorul din token
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { createToken } = require('./auth-token');
const { currentUser } = require('./current-user');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
// Coloanele trimise frontend-ului (fără password_hash!).
const PUBLIC_FIELDS = `user_id, full_name, email, role, phone, department,
  laboratory, academic_title, office`;

function session(user) {
  return { token: createToken(user), user };
}

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Completează emailul și parola.' });
  }
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_FIELDS}, password_hash FROM users
     WHERE LOWER(email) = $1`,
    [email],
  );
  const found = rows[0];
  // Același mesaj pentru email greșit și parolă greșită (nu ghicim conturi).
  if (!found || !(await bcrypt.compare(password, found.password_hash))) {
    return res.status(401).json({ error: 'Email sau parolă greșită.' });
  }
  const { password_hash: hidden, ...user } = found;
  res.json(session(user));
});

// Validează datele din formularul „Creează cont”.
function validateRegister(body) {
  const errors = {};
  const fullName = String(body.full_name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (fullName.length < 3) errors.full_name = 'Completează numele complet.';
  if (!EMAIL_RE.test(email)) errors.email = 'Adresa de email nu este validă.';
  if (password.length < MIN_PASSWORD ||
      !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    errors.password = `Parola trebuie să aibă cel puțin ${MIN_PASSWORD} ` +
      'caractere, cu litere și cifre.';
  }
  return { errors, fullName, email, password };
}

// Conturile noi sunt de cercetător. Administratorii se stabilesc separat
// (KAN-20 – atribuire roluri).
router.post('/register', async (req, res) => {
  const { errors, fullName, email, password } = validateRegister(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Verifică câmpurile marcate.', errors });
  }

  const optional = (name) => String(req.body[name] || '').trim() || null;
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role, phone,
         department, laboratory, academic_title)
       VALUES ($1, $2, $3, 'RESEARCHER', $4, $5, $6, $7)
       RETURNING ${PUBLIC_FIELDS}`,
      [fullName, email, hash, optional('phone'), optional('department'),
        optional('laboratory'), optional('academic_title')],
    );
    res.status(201).json(session(rows[0]));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Există deja un cont cu acest email.',
        errors: { email: 'Există deja un cont cu acest email.' },
      });
    }
    throw err;
  }
});

router.get('/me', currentUser, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_FIELDS} FROM users WHERE user_id = $1`,
    [req.userId],
  );
  if (!rows.length) {
    return res.status(401).json({ error: 'Contul nu mai există.' });
  }
  res.json(rows[0]);
});

module.exports = router;
