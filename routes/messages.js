const express = require('express');
const { upload } = require('../config/cloudinary');
const { 
    getChatHistory, 
    uploadMedia, 
    burnMessage,
    searchMessages,
    searchFiles,
    uploadAudio,
    getRoomMedia
} = require('../controllers/messageController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// Media handling
router.post('/upload', protect, upload.single('media'), uploadMedia);
router.post('/upload/audio', protect, uploadAudio);

// Chat history and search
router.get('/search', protect, searchMessages);
router.get('/files', protect, searchFiles);
router.get('/:roomId/media', protect, getRoomMedia);
router.get('/:room', protect, getChatHistory);

// Security engine
router.delete('/burn/:id', protect, burnMessage);

module.exports = router;