// KAN-19: token-ul de autentificare (JWT).
// După login, frontend-ul trimite token-ul la fiecare cerere în antetul
// „Authorization: Bearer <token>”, iar backend-ul știe cine e utilizatorul.
const jwt = require('jsonwebtoken');

const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) {
    throw new Error('Lipsește JWT_SECRET din .env (vezi .env.example)');
  }
  return value;
}

// Creează token-ul pentru un utilizator din tabelul users.
function createToken(user) {
  return jwt.sign({ sub: user.user_id, role: user.role }, secret(), {
    expiresIn: EXPIRES_IN,
  });
}

// Întoarce { userId, role } sau null dacă token-ul e invalid ori expirat.
function readToken(token) {
  try {
    const payload = jwt.verify(token, secret());
    return { userId: payload.sub, role: payload.role };
  } catch (err) {
    if (err.message.startsWith('Lipsește JWT_SECRET')) throw err;
    return null;
  }
}

module.exports = { createToken, readToken };
