// Stabilește cine este utilizatorul curent (req.userId, req.userRole).
//
// KAN-19: utilizatorul vine din token-ul de login, trimis de frontend în
// antetul „Authorization: Bearer <token>”.
// Pentru teste fără login (Postman, curl) se poate folosi încă antetul
// X-User-Id sau DEMO_USER_ID din .env. Lăsați DEMO_USER_ID gol ca să
// cereți login obligatoriu.
const { readToken } = require('./auth-token');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function currentUser(req, res, next) {
  const header = req.get('Authorization') || '';
  if (header.startsWith('Bearer ')) {
    const user = readToken(header.slice(7));
    if (!user) {
      return res.status(401).json({
        error: 'Sesiunea a expirat. Autentifică-te din nou.',
      });
    }
    req.userId = user.userId;
    req.userRole = user.role;
    return next();
  }

  // Fără token: doar pentru teste (vezi comentariul de sus).
  const userId = req.get('X-User-Id') || process.env.DEMO_USER_ID;
  if (!userId) {
    return res.status(401).json({ error: 'Trebuie să fii autentificat.' });
  }
  if (!UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'X-User-Id trebuie să fie un UUID' });
  }
  req.userId = userId;
  next();
}

module.exports = { currentUser, UUID_RE };
