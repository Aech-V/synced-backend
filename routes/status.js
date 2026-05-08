const express = require('express');
const { getStatuses, createStatus } = require('../controllers/statusController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// Status operations
router.get('/', protect, getStatuses);
router.post('/', protect, createStatus);

module.exports = router;