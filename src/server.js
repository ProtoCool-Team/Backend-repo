require('dotenv').config();
const express = require('express');
const pool = require('./db');
const resourcesRouter = require('./resources.routes');

const app = express();
app.use(express.json());

app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
});

app.use('/api/resources', resourcesRouter);


app.use((req, res) => {
  res.status(404).json({ error: 'Ruta nu există' });
});

const PG_ERRORS = {
  '23503': [400, 'location_id sau responsible_admin_id nu există în baza de date'],
  '23502': [400, 'Lipsește un câmp obligatoriu'],
  '23514': [400, 'Valoarea nu respectă constrângerile bazei de date'],
  '22P02': [400, 'Format de date invalid'],
};

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalid în corpul cererii' });
  }
  const known = PG_ERRORS[err.code];
  if (known) {
    return res.status(known[0]).json({ error: known[1], detail: err.detail });
  }
  console.error(err);
  res.status(500).json({ error: 'Eroare internă de server' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RRM backend rulează pe http://localhost:${PORT}`);
});