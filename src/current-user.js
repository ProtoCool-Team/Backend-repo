// Stabilește cine este utilizatorul curent (req.userId, req.userRole).
//
// KAN-19: utilizatorul vine din token-ul de login, trimis de frontend în
// antetul „Authorization: Bearer <token>”.
// KAN-20: rolul se citește din baza de date la fiecare cerere, nu din
// token, ca o schimbare de rol să se aplice imediat.
//
// Pentru teste fără login (Postman, curl) se poate folosi antetul X-User-Id
// sau DEMO_USER_ID din .env, DAR doar dacă ALLOW_DEMO_AUTH=true. Implicit,
// o cerere fără token primește 401.
const pool = require('./db');
const { readToken } = require('./auth-token');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ROLES = { RESEARCHER: 'RESEARCHER', ADMINISTRATOR: 'ADMINISTRATOR' };

function demoAuthAllowed() {
  return process.env.ALLOW_DEMO_AUTH === 'true';
}

// Id-ul utilizatorului din cerere sau un răspuns de eroare.
function userIdFrom(req) {
  const header = req.get('Authorization') || '';
  if (header.startsWith('Bearer ')) {
    const user = readToken(header.slice(7));
    if (!user) {
      return { status: 401, error: 'Sesiunea a expirat. Autentifică-te din nou.' };
    }
    return { userId: user.userId };
  }

  // Fără token: doar pentru teste, dacă e pornit explicit.
  const userId = demoAuthAllowed()
    ? req.get('X-User-Id') || process.env.DEMO_USER_ID
    : null;
  if (!userId) return { status: 401, error: 'Trebuie să fii autentificat.' };
  if (!UUID_RE.test(userId)) {
    return { status: 400, error: 'X-User-Id trebuie să fie un UUID' };
  }
  return { userId };
}

async function currentUser(req, res, next) {
  const found = userIdFrom(req);
  if (found.error) return res.status(found.status).json({ error: found.error });

  const { rows } = await pool.query(
    'SELECT role FROM users WHERE user_id = $1',
    [found.userId],
  );
  if (!rows.length) {
    return res.status(401).json({ error: 'Contul nu mai există.' });
  }
  req.userId = found.userId;
  req.userRole = rows[0].role;
  next();
}

// KAN-20: doar administratorii (cadre didactice / responsabili de laborator).
function requireAdmin(req, res, next) {
  if (req.userRole !== ROLES.ADMINISTRATOR) {
    return res.status(403).json({
      error: 'Doar administratorii pot face această operație.',
    });
  }
  next();
}

// Pentru rute: [...adminOnly] = autentificat + administrator.
const adminOnly = [currentUser, requireAdmin];

module.exports = { currentUser, requireAdmin, adminOnly, ROLES, UUID_RE };
