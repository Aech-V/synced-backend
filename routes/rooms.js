const express = require('express');
const { createChatRoom, dispatchBroadcast, getSecretRooms, unlockSecretRoom, findOrCreateDirectRoom, clearHistory } = require('../controllers/roomController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// Room initialization
router.post('/create', protect, createChatRoom);
router.post('/findOrCreate', protect, findOrCreateDirectRoom);

// Broadcast engine
router.post('/broadcast', protect, dispatchBroadcast);

// Secret chat vault
router.get('/vault', protect, getSecretRooms);
router.post('/vault/unlock', protect, unlockSecretRoom);

// Data management
router.put('/:roomId/clearHistory', protect, clearHistory);

module.exports = router;