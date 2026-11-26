// Rulează fn(client) într-o tranzacție: COMMIT dacă reușește, ROLLBACK la
// orice eroare (eroarea merge mai departe, la handler-ul din server.js).
const pool = require('./db');

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
