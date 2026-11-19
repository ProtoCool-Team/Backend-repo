// Stabilește cine este utilizatorul curent (req.userId).
//
// TEMPORAR, până avem autentificare: id-ul vine din antetul X-User-Id
// trimis de frontend sau, dacă lipsește, din DEMO_USER_ID din .env.
// TODO (autentificare): înlocuiți cu id-ul din token-ul de login (JWT).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function currentUser(req, res, next) {
  const userId = req.get('X-User-Id') || process.env.DEMO_USER_ID;
  if (!userId) {
    return res.status(401).json({
      error: 'Utilizator necunoscut: trimiteți antetul X-User-Id ' +
        'sau setați DEMO_USER_ID în .env',
    });
  }
  if (!UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'X-User-Id trebuie să fie un UUID' });
  }
  req.userId = userId;
  next();
}

module.exports = { currentUser, UUID_RE };
