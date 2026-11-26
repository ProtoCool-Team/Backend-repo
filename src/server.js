require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const authRouter = require('./auth.routes');
const resourcesRouter = require('./resources.routes');
const locationsRouter = require('./locations.routes');
const myReservationsRouter = require('./my-reservations.routes');
const reservationActionsRouter = require('./reservation-actions.routes');
const resourceReservationsRouter = require('./resource-reservations.routes');
const usersRouter = require('./users.routes');

// Fără cheia de semnare, niciun login nu poate funcționa: oprim pornirea.
if (!process.env.JWT_SECRET) {
  console.error('Lipsește JWT_SECRET din .env (vezi .env.example).');
  process.exit(1);
}

// Toate rutele API sunt sub /api/v1 (Livrabil 5, Lab 6 pasul 3.7.3).
const API_PREFIX = '/api/v1';

const app = express();

// Doar frontend-ul are voie să apeleze API-ul din browser (Lab 6, 3.7.2).
// Mai multe adrese se pot da în CORS_ORIGIN, separate prin virgulă.
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',');
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());
app.use(`${API_PREFIX}/auth`, authRouter);

app.get(`${API_PREFIX}/health`, async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
});

app.use(
  `${API_PREFIX}/resources/:id/reservations`,
  resourceReservationsRouter,
);
app.use(`${API_PREFIX}/resources`, resourcesRouter);
app.use(`${API_PREFIX}/locations`, locationsRouter);
app.use(`${API_PREFIX}/users`, usersRouter);
app.use(`${API_PREFIX}/me/reservations`, myReservationsRouter);
app.use(`${API_PREFIX}/me/reservations`, reservationActionsRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta nu există' });
});

// Singurul loc unde codurile de eroare Postgres devin răspunsuri HTTP.
// 23503 (cheie străină) înseamnă altceva în funcție de operație: la DELETE,
// alte date (ex. rezervări) încă trimit la resursă; altfel, resursa trimite
// la o locație sau un administrator care nu există.
const PG_ERRORS = {
  '23503': (req) => (req.method === 'DELETE'
    ? [409, 'Resursa nu poate fi ștearsă: are rezervări sau alte date asociate']
    : [400, 'location_id sau responsible_admin_id nu există în baza de date']),
  '23502': () => [400, 'Lipsește un câmp obligatoriu'],
  '23514': () => [400, 'Valoarea nu respectă constrângerile bazei de date'],
  '22001': () => [400, 'Valoare prea lungă pentru unul dintre câmpuri'],
  '22P02': () => [400, 'Format de date invalid'],
  // KAN-15: două cereri simultane pe același interval (constrângerea
  // no_overlapping_reservations) – a doua e respinsă.
  '23P01': () => [409, 'Intervalul se suprapune cu o rezervare existentă pentru această resursă'],
  // RAISE EXCEPTION din trigger-ele de rol (P0001). Mesajul depinde de
  // trigger: trg_reservations_researcher sau trg_decisions_administrator.
  'P0001': (req, err) => [403, roleTriggerMessage(err.message)],
};

function roleTriggerMessage(message = '') {
  if (message.includes('RESEARCHER')) {
    return 'Doar utilizatorii cu rolul de cercetător pot face rezervări';
  }
  if (message.includes('ADMINISTRATOR')) {
    return 'Doar administratorii pot lua această decizie';
  }
  return message || 'Operație nepermisă';
}

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalid în corpul cererii' });
  }
  const known = PG_ERRORS[err.code]?.(req, err);
  if (known) {
    return res.status(known[0]).json({ error: known[1], detail: err.detail });
  }
  console.error(err);
  res.status(500).json({ error: 'Eroare internă de server' });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`RRM backend rulează pe http://localhost:${PORT}${API_PREFIX}`);
});
