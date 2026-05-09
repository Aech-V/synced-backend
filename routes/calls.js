const express = require('express');
const router = express.Router();
const CallLog = require('../models/CallLog');
const { protect } = require('../middlewares/authMiddleware');

// Fetch paginated call history
router.get('/history', protect, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const lastSeenId = req.query.cursor;
        const userId = req.user.id || req.user._id; 

        const query = {
            $or: [{ callerId: userId }, { 'participants.userId': userId }],
            deletedFor: { $ne: userId } 
        };

        if (lastSeenId) {
            query._id = { $lt: lastSeenId };
        }

        const calls = await CallLog.find(query)
            .populate('callerId', 'username avatar')
            .populate('participants.userId', 'username avatar')
            .populate('roomId', 'name type participants')
            .sort({ _id: -1 })
            .limit(limit);

        const nextCursor = calls.length === limit ? calls[calls.length - 1]._id : null;

        res.status(200).json({ success: true, data: calls, nextCursor });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Server error retrieving call history' });
    }
});

// Soft-delete an individual call log
router.post('/delete/:callId', protect, async (req, res) => {
    try {
        const callId = req.params.callId;
        const userId = req.user.id || req.user._id;

        await CallLog.findByIdAndUpdate(callId, {
            $addToSet: { deletedFor: userId }
        });

        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to delete call log' });
    }
});

module.exports = router;