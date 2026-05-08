const Message = require('../models/Message');
const Room = require('../models/Room');
const { cloudinary } = require('../config/cloudinary');

// @desc Fetch paginated chat history using performant Cursors
// @route GET /api/messages/:room?limit=50&cursor=last_id
exports.getChatHistory = async (req, res) => {
    try {
        const roomName = req.params.room;
        let targetRoom = await Room.findOne({ name: roomName });
        
        if (!targetRoom) {
            targetRoom = await Room.create({ name: roomName, type: 'channel' });
            console.log(`[DB SETUP]: Created new Channel document for #${roomName}`);
        }

        const limit = parseInt(req.query.limit) || 50;
        const cursor = req.query.cursor;
        const currentUserId = req.user.id; 
        
        const myParticipant = targetRoom.participants?.find(p => 
            (p.userId?._id || p.userId).toString() === currentUserId.toString()
        );
        const clearThreshold = myParticipant?.clearedAt || new Date(0);

        const query = { 
            roomId: targetRoom._id,
            createdAt: { $gt: clearThreshold } 
        };

        if (cursor) {
            query._id = { $lt: cursor };
        }

        const messages = await Message.find(query)
            .sort({ _id: -1 })
            .limit(limit)
            .populate('senderId', 'username avatar')
            .populate('replyTo', 'text type imageUrl gifUrl audioUrl stickerData senderName');

        const nextCursor = messages.length === limit ? messages[messages.length - 1]._id : null;

        await Message.updateMany(
            { roomId: targetRoom._id, senderId: { $ne: currentUserId }, status: { $ne: 'read' } },
            { $set: { status: 'read' } }
        );

        res.status(200).json({ success: true, data: messages, nextCursor });
    } catch (error) {
        console.error('Error fetching history:', error);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
};

// @desc Handle rich media uploads to Cloudinary
// @route POST /api/messages/upload
exports.uploadMedia = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }

        const isMedia = req.file.mimetype.startsWith('image/') || req.file.mimetype.startsWith('video/');
        const resourceType = isMedia ? 'auto' : 'raw';

        const uploadOptions = {
            folder: 'synced_uploads',
            resource_type: resourceType,
        };

        const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
                if (error) {
                    console.error("[CLOUDINARY UPLOAD ERROR]:", error);
                    reject(error);
                } else {
                    resolve(result);
                }
            });
            stream.end(req.file.buffer);
        });

        res.status(200).json({ 
            mediaUrl: result.secure_url,
            publicId: result.public_id,
            fileSize: req.file.size,
            fileFormat: req.file.mimetype
        });
    } catch (error) {
        console.error('Media upload error:', error);
        res.status(500).json({ error: 'Failed to upload media' });
    }
};

// @desc Hard delete ephemeral messages and media
// @route DELETE /api/messages/burn/:id
exports.burnMessage = async (req, res) => {
    try {
        const messageId = req.params.id;
        const message = await Message.findById(messageId);
        
        if (!message) return res.status(404).json({ error: 'Message not found' });

        let mediaDestroyed = true;

        if (message.imageUrl && message.imageUrl.includes('cloudinary')) {
            const filename = message.imageUrl.split('/').pop().split('.')[0];
            const publicId = `synced_uploads/${filename}`;
            
            try {
                await cloudinary.uploader.destroy(publicId);
            } catch (err) {
                console.error(`[SECURITY WARNING]: Cloudinary drop failed for ${publicId}`, err);
                mediaDestroyed = false;
            }
        }

        if (message.audioUrl && message.audioUrl.includes('cloudinary')) {
            const filename = message.audioUrl.split('/').pop().split('.')[0];
            const publicId = `synced_audio/${filename}`;
            
            try {
                await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
            } catch (err) {
                console.error(`[SECURITY WARNING]: Cloudinary drop failed for ${publicId}`, err);
                mediaDestroyed = false;
            }
        }

        if (!mediaDestroyed) {
             message.isDeleted = true;
             message.text = "[Media flagged for hard deletion sync]";
             await message.save();
             return res.status(202).json({ message: 'Target scheduled for cleanup engine due to network delay' });
        }

        await Message.findByIdAndDelete(messageId);
        res.status(200).json({ message: 'Target burned successfully' });
    } catch (error) {
        console.error('Burn error:', error);
        res.status(500).json({ error: 'Failed to burn message' });
    }
};

// @desc Search text messages across all user rooms
// @route GET /api/messages/search?q=...
exports.searchMessages = async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ error: 'Search query is required' });

        const userRooms = await Room.find({ 'participants.userId': req.user.id }).select('_id');
        const roomIds = userRooms.map(r => r._id);

        const messages = await Message.find({
            roomId: { $in: roomIds },
            text: { $regex: query, $options: 'i' },
            type: { $ne: 'system' }
        })
        .populate('senderId', 'username avatar')
        .populate('roomId', 'name type')
        .sort({ createdAt: -1 })
        .limit(15);

        res.status(200).json(messages);
    } catch (error) {
        console.error('Message Search Error:', error);
        res.status(500).json({ error: 'Failed to search messages' });
    }
};

// @desc Search files and media across all user rooms
// @route GET /api/messages/files?q=...
exports.searchFiles = async (req, res) => {
    try {
        const query = req.query.q || '';

        const userRooms = await Room.find({ 'participants.userId': req.user.id }).select('_id');
        const roomIds = userRooms.map(r => r._id);

        const files = await Message.find({
            roomId: { $in: roomIds },
            $or: [
                { imageUrl: { $exists: true, $ne: '' } },
                { gifUrl: { $exists: true, $ne: '' } },
                { audioUrl: { $exists: true, $ne: '' } },
                { type: 'document' }
            ],
            ...(query && { text: { $regex: query, $options: 'i' } })
        })
        .populate('senderId', 'username avatar')
        .populate('roomId', 'name type')
        .sort({ createdAt: -1 })
        .limit(15);

        res.status(200).json(files);
    } catch (error) {
        console.error('File Search Error:', error);
        res.status(500).json({ error: 'Failed to search files' });
    }
};

// @desc Direct audio upload handling with Data URI sanitization
// @route POST /api/messages/upload/audio
exports.uploadAudio = async (req, res) => {
    try {
        let fileData = req.body.audio; 
        const isVoiceNote = req.body.isVoiceNote === true || req.body.isVoiceNote === 'true';

        if (!fileData) {
            return res.status(400).json({ success: false, message: "No audio data provided." });
        }

        // Sanitize Data URI for Cloudinary compatibility
        if (typeof fileData === 'string' && fileData.includes(';codecs=')) {
            fileData = fileData.replace(/;codecs=[^;]+;/, ';').replace(/;codecs=[^;]+/, '');
        }

        const uploadOptions = {
            resource_type: "video", 
            folder: "synced_audio",
        };

        if (isVoiceNote) {
            uploadOptions.format = "mp3";
            uploadOptions.eager = [{ format: "mp3", audio_codec: "mp3" }];
            uploadOptions.eager_async = false; 
        }

        const result = await cloudinary.uploader.upload(fileData, uploadOptions);

        res.status(200).json({
            success: true,
            url: result.secure_url,
            duration: req.body.duration || 0,
            size: result.bytes,
            format: result.format
        });
    } catch (error) {
        console.error("Audio Upload Error:", error);
        res.status(500).json({ success: false, message: "Media engine failed to process audio." });
    }
};

// @desc Get Shared Media Gallery
// @route GET /api/messages/:roomId/media
exports.getRoomMedia = async (req, res) => {
    try {
        const { roomId } = req.params;
        const currentUserId = req.user.id;

        const room = await Room.findById(roomId);
        if (!room) return res.status(404).json({ success: false, message: 'Room not found' });

        const myParticipant = room.participants.find(p => p.userId.toString() === currentUserId);
        const clearThreshold = myParticipant?.clearedAt || new Date(0);

        const mediaMessages = await Message.find({
            roomId,
            createdAt: { $gt: clearThreshold },
            $or: [
                { imageUrl: { $ne: null } },
                { audioUrl: { $ne: null } },
                { type: 'document' },
                { type: 'snippet' }
            ]
        })
        .sort({ createdAt: -1 })
        .select('imageUrl audioUrl type documentData snippetData createdAt')
        .lean();

        res.status(200).json({ success: true, data: mediaMessages });
    } catch (error) {
        console.error("Get Room Media Error:", error);
        res.status(500).json({ success: false, message: "Failed to fetch gallery." });
    }
};