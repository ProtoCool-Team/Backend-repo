require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const resourcesRouter = require('./resources.routes');
const locationsRouter = require('./locations.routes');

// Toate rutele API sunt sub /api/v1 (Livrabil 5, Lab 6 pasul 3.7.3).
const API_PREFIX = '/api/v1';

const app = express();

// Doar frontend-ul are voie să apeleze API-ul din browser (Lab 6, 3.7.2).
// Mai multe adrese se pot da în CORS_ORIGIN, separate prin virgulă.
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',');
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get(`${API_PREFIX}/health`, async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
});

app.use(`${API_PREFIX}/resources`, resourcesRouter);
app.use(`${API_PREFIX}/locations`, locationsRouter);

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
};

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalid în corpul cererii' });
  }
  const known = PG_ERRORS[err.code]?.(req);
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
