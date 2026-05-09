const Room = require('../models/Room');
const Message = require('../models/Message');
const User = require('../models/User');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

// @desc    Create a new Chat Room (DM, Channel, Group, Secret)
// @route   POST /api/rooms/create
exports.createChatRoom = async (req, res) => {
    try {
        const { type, targetUserIds, name, description, avatar, password } = req.body;
        const currentUserId = req.user.id;

        let newRoom;

        switch (type) {
            case 'direct':
                const targetUserId = targetUserIds[0];
                let existingDM = await Room.findOne({
                    type: 'direct',
                    'participants.userId': { $all: [currentUserId, targetUserId] },
                    participants: { $size: 2 }
                }).populate('participants.userId', 'username avatar isOnline lastSeen').populate('lastMessage');

                if (existingDM) {
                    return res.status(200).json({ isExisting: true, room: existingDM });
                }

                newRoom = await Room.create({
                    name: uuidv4(),
                    type: 'direct',
                    participants: [{ userId: currentUserId, role: 'admin' }, { userId: targetUserId, role: 'member' }]
                });
                break;

            case 'secret':
                if (!password) return res.status(400).json({ error: 'Password required for secret chats' });

                const salt = await bcrypt.genSalt(10);
                const hashedPassword = await bcrypt.hash(password, salt);

                newRoom = await Room.create({
                    name: uuidv4(),
                    type: 'secret',
                    isSecret: true,
                    password: hashedPassword,
                    participants: [{ userId: currentUserId, role: 'admin' }, { userId: targetUserIds[0], role: 'member' }]
                });
                break;

            case 'group':
                const groupParticipants = targetUserIds.map(id => ({ userId: id, role: 'member' }));
                groupParticipants.push({ userId: currentUserId, role: 'admin' });

                newRoom = await Room.create({
                    name: name || 'New Group',
                    type: 'group',
                    avatar,
                    participants: groupParticipants
                });
                break;

            case 'channel':
                newRoom = await Room.create({
                    name,
                    type: 'channel',
                    description,
                    avatar,
                    participants: [{ userId: currentUserId, role: 'admin' }]
                });
                break;

            default:
                return res.status(400).json({ error: 'Invalid chat type' });
        }

        const creator = await User.findById(currentUserId);
        const systemMessage = await Message.create({
            roomId: newRoom._id,
            senderId: currentUserId,
            senderName: 'System',
            type: 'system',
            text: `${creator.username} created the chat.`,
            status: 'sent'
        });

        newRoom.lastMessage = systemMessage._id;
        await newRoom.save();

        const populatedRoom = await Room.findById(newRoom._id)
            .populate('participants.userId', 'username avatar isOnline lastSeen')
            .populate('lastMessage');

        res.status(201).json({ isExisting: false, room: populatedRoom });

    } catch (error) {
        console.error("Room Creation Error:", error);
        res.status(500).json({ error: 'Failed to create chat space' });
    }
};

// @desc    Dispatch a Broadcast Message
// @route   POST /api/rooms/broadcast
exports.dispatchBroadcast = async (req, res) => {
    try {
        const { targetUserIds, text, imageUrl } = req.body;
        const currentUserId = req.user.id;

        if (!targetUserIds || targetUserIds.length === 0 || targetUserIds.length > 50) {
            return res.status(400).json({ error: 'Broadcast must have between 1 and 50 recipients.' });
        }

        const sender = await User.findById(currentUserId);

        const dispatchPromises = targetUserIds.map(async (targetId) => {
            try {
                const dm = await Room.findOneAndUpdate(
                    {
                        type: 'direct',
                        'participants.userId': { $all: [currentUserId, targetId] },
                        participants: { $size: 2 }
                    },
                    {
                        $setOnInsert: {
                            name: uuidv4(),
                            type: 'direct',
                            participants: [{ userId: currentUserId }, { userId: targetId }]
                        }
                    },
                    { new: true, upsert: true }
                );

                const msg = await Message.create({
                    roomId: dm._id,
                    senderId: currentUserId,
                    senderName: sender.username,
                    type: imageUrl ? 'image' : 'text',
                    text: text,
                    imageUrl: imageUrl,
                    status: 'sent',
                    fileSize: req.body.fileSize || 0,
                    fileFormat: req.body.fileFormat || 'text'
                });

                await Room.findByIdAndUpdate(dm._id, { lastMessage: msg._id });
                return true;
            } catch (innerError) {
                console.error(`Failed to dispatch to user ${targetId}:`, innerError);
                return false;
            }
        });

        const results = await Promise.all(dispatchPromises);
        const dispatchCount = results.filter(success => success).length;

        res.status(200).json({ message: `Broadcast successfully dispatched to ${dispatchCount} users.` });

    } catch (error) {
        console.error("Broadcast Error:", error);
        res.status(500).json({ error: 'Failed to dispatch broadcast' });
    }
};

// @desc    Fetch a user's hidden Secret Chats
// @route   GET /api/rooms/vault
exports.getSecretRooms = async (req, res) => {
    try {
        const secretRooms = await Room.find({
            type: 'secret',
            'participants.userId': req.user.id
        })
            .populate('participants.userId', 'username avatar')
            .select('-password')
            .sort({ updatedAt: -1 });

        res.status(200).json(secretRooms);
    } catch (error) {
        res.status(500).json({ error: 'Failed to access vault' });
    }
};

// @desc    Unlock a specific Secret Chat
// @route   POST /api/rooms/vault/unlock
exports.unlockSecretRoom = async (req, res) => {
    try {
        const { roomId, password } = req.body;
        const room = await Room.findById(roomId);

        if (!room || room.type !== 'secret') return res.status(404).json({ error: 'Room not found' });

        const isMatch = await bcrypt.compare(password, room.password);
        if (!isMatch) return res.status(401).json({ error: 'Invalid vault password' });

        res.status(200).json({ success: true, room });
    } catch (error) {
        res.status(500).json({ error: 'Failed to decrypt room' });
    }
};

// @desc    Find or Create Direct Message Room
// @route   POST /api/rooms/findOrCreate
exports.findOrCreateDirectRoom = async (req, res) => {
    try {
        const { targetUserId } = req.body;
        const currentUserId = req.user.id;

        let room = await Room.findOne({
            name: uuidv4(),
            type: 'direct',
            'participants.userId': { $all: [currentUserId, targetUserId] }
        }).populate('participants.userId', 'username avatar isOnline');

        if (room) {
            return res.status(200).json({ success: true, room });
        }

        const newRoom = new Room({
            type: 'direct',
            participants: [
                { userId: currentUserId, role: 'admin', clearedAt: new Date(0) },
                { userId: targetUserId, role: 'member', clearedAt: new Date(0) }
            ]
        });

        await newRoom.save();
        const populatedRoom = await Room.findById(newRoom._id)
            .populate('participants.userId', 'username avatar isOnline');

        res.status(201).json({ success: true, room: populatedRoom });
    } catch (error) {
        console.error("Find/Create Room Error:", error);
        res.status(500).json({ success: false, message: "Failed to initialize conversation." });
    }
};

// @desc    Clear chat history via Soft Delete
// @route   PUT /api/rooms/:roomId/clearHistory
exports.clearHistory = async (req, res) => {
    try {
        const { roomId } = req.params;
        const currentUserId = req.user.id;
        const updatedRoom = await Room.findOneAndUpdate(
            { 
                $or: [{ _id: roomId }, { name: roomId }],
                'participants.userId': currentUserId 
            },
            { $set: { 'participants.$.clearedAt': new Date() } },
            { returnDocument: 'after' } 
        );

        if (!updatedRoom) {
            return res.status(404).json({ success: false, message: 'Room or Participant not found' });
        }

        res.status(200).json({ success: true, message: 'History cleared securely' });
    } catch (error) {
        console.error("Clear History Error:", error);
        res.status(500).json({ success: false, message: "Failed to clear history." });
    }
};