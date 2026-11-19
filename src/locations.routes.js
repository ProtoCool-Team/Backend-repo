const express = require('express');
const pool = require('./db');

const router = express.Router();

// READ (listă): locațiile din care se poate alege la adăugarea unei resurse.
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT location_id, building, room, floor FROM locations ORDER BY building, room'
  );
  res.json(rows);
});

module.exports = router;
