// Rulează fn(client) într-o tranzacție: COMMIT dacă reușește, ROLLBACK la
// orice eroare (eroarea merge mai departe, la handler-ul din server.js).
const pool = require('./db');

async function withTransaction(fn) {
  const client = await pool.connect();
  let rollbackError;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      rollbackError = rbErr;
    }
    throw err;
  } finally {
    if (rollbackError !== undefined) {
      client.release(rollbackError);
    } else {
      client.release();
    }
  }
}

module.exports = { withTransaction };
