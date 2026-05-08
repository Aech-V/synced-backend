const Status = require('../models/Status');

// @desc    Fetch all active 24-hour statuses (Paginated)
// @route   GET /api/status?limit=20&cursor=last_id
exports.getStatuses = async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const lastSeenId = req.query.cursor;

        // Base query: Only fetch statuses that have not expired
        const query = { expiresAt: { $gt: new Date() } };

        // If a cursor is provided, fetch documents strictly older than the cursor ID
        if (lastSeenId) {
            query._id = { $lt: lastSeenId };
        }

        const statuses = await Status.find(query)
            .populate('userId', 'username avatar')
            .sort({ _id: -1 }) // Sort descending by _id (which inherently encapsulates the creation timestamp)
            .limit(limit);

        // Determine the next cursor to send to the frontend for infinite scrolling
        const nextCursor = statuses.length === limit ? statuses[statuses.length - 1]._id : null;

        // Return a structured object containing the data and pagination metadata
        res.status(200).json({ success: true, data: statuses, nextCursor });
    } catch (error) {
        console.error("Status Fetch Error:", error);
        res.status(500).json({ success: false, error: 'Failed to fetch statuses' });
    }
};

// @desc    Upload a new Status
// @route   POST /api/status
exports.createStatus = async (req, res) => {
    try {
        const { mediaUrl, caption } = req.body;
        const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const newStatus = await Status.create({
            userId: req.user.id,
            mediaUrl,
            caption,
            expiresAt: expirationDate
        });

        res.status(201).json({ success: true, data: newStatus });
    } catch (error) {
        console.error("Status Create Error:", error);
        res.status(500).json({ success: false, error: 'Failed to create status' });
    }
};