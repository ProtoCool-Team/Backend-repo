// KAN-15: prevenirea automată a suprapunerilor.
//
// Două niveluri de protecție:
//  1. Înainte de salvare verificăm cu funcția is_resource_free din baza de
//     date, ca utilizatorul să primească un mesaj clar.
//  2. Dacă două cereri ajung în același timp, constrângerea
//     no_overlapping_reservations din baza de date o respinge pe a doua
//     (cod Postgres 23P01), iar server.js o transformă într-un 409.
const pool = require('./db');

// Statusurile care ocupă resursa (la fel ca în constrângere).
const BLOCKING = ['PENDING', 'APPROVED', 'ACTIVE'];

const OVERLAP_MESSAGE =
  'Intervalul se suprapune cu o rezervare existentă pentru această resursă';

async function isFree(resourceId, start, end) {
  const { rows } = await pool.query(
    'SELECT is_resource_free($1, $2, $3) AS free',
    [resourceId, start, end],
  );
  return rows[0].free;
}

module.exports = { BLOCKING, OVERLAP_MESSAGE, isFree };
