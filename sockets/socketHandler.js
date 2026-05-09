const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Message = require('../models/Message');
const Room = require('../models/Room');
const { cloudinary } = require('../config/cloudinary');
const CallLog = require('../models/CallLog');

const onlineUsers = new Map();
const activeSocketCalls = new Map();
const recentCallAttempts = new Map();

const BYPASS_WINDOW_MS = 3 * 60 * 1000;
const REQUIRED_ATTEMPTS = 3;

// Bounded Auth Cache to prevent DB hammering on mass reconnects
const socketAuthCache = new Map();
const AUTH_CACHE_TTL = 5 * 60 * 1000;
const MAX_AUTH_CACHE_SIZE = 10000;

// Periodic garbage collection for Maps
setInterval(() => {
    const now = Date.now();

    for (const [attemptKey, attempts] of recentCallAttempts.entries()) {
        const valid = attempts.filter(time => now - time < BYPASS_WINDOW_MS);
        if (valid.length === 0) {
            recentCallAttempts.delete(attemptKey);
        } else {
            recentCallAttempts.set(attemptKey, valid);
        }
    }

    for (const [key, value] of socketAuthCache.entries()) {
        if (now - value.timestamp >= AUTH_CACHE_TTL) {
            socketAuthCache.delete(key);
        }
    }
}, 60000).unref();

module.exports = (io) => {
    // Security Middleware
    io.use(async (socket, next) => {
        const token = socket.handshake.auth.token;
        if (!token) return next(new Error('Authentication error: No token provided'));

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const currentTime = Date.now();
            
            let user;
            let cachedData = socketAuthCache.get(decoded.userId);

            if (cachedData && (currentTime - cachedData.timestamp < AUTH_CACHE_TTL)) {
                user = cachedData.user;
            } else {
                user = await User.findById(decoded.userId).select('lockUntil activeSessions');
                if (user) {
                    if (socketAuthCache.size >= MAX_AUTH_CACHE_SIZE) {
                        const oldestKey = socketAuthCache.keys().next().value;
                        socketAuthCache.delete(oldestKey);
                    }
                    socketAuthCache.set(decoded.userId, { user, timestamp: currentTime });
                }
            }
            
            if (!user) return next(new Error('Authentication error: User account no longer exists'));
            
            if (user.lockUntil && user.lockUntil > currentTime) {
                return next(new Error('Authentication error: Account is temporarily locked'));
            }

            if (user.activeSessions && decoded.sessionId && !user.activeSessions.some(s => s.sessionId === decoded.sessionId)) {
                return next(new Error('Authentication error: Session revoked'));
            }

            socket.userId = decoded.userId;
            next();
        } catch (error) {
            return next(new Error('Authentication error: Invalid token'));
        }
    });

    // Connection Initialization
    io.on('connection', async (socket) => {
        socket.join(socket.userId.toString());
        console.log(`[NETWORK]: User ${socket.userId} connected. Socket ID: ${socket.id}`);

        onlineUsers.set(socket.userId.toString(), socket.id);
        await User.findByIdAndUpdate(socket.userId, { isOnline: true });

        socket.broadcast.emit('user_status_change', { userId: socket.userId, isOnline: true });

        // Room Management
        socket.on('join_room', async (roomId) => {
            Array.from(socket.rooms).forEach(room => {
                if (room !== socket.id) socket.leave(room);
            });

            socket.join(roomId);
            console.log(`[MATRIX]: User ${socket.userId} joined Room ${roomId}`);

            // FIX: Safely support both ObjectId and Name lookups for exact timestamp syncing
            const isObjectId = /^[0-9a-fA-F]{24}$/.test(roomId);
            const roomQuery = isObjectId ? { $or: [{ name: roomId }, { _id: roomId }] } : { name: roomId };

            await Room.updateOne(
                { ...roomQuery, "participants.userId": socket.userId },
                { $set: { "participants.$.lastReadTimestamp": new Date() } }
            );
        });

        // Message Dispatch
        socket.on('send_message', async (data, callback) => {
            try {
                const user = await User.findById(socket.userId);
                const roomName = data.room || data.roomId;
                
                let targetRoom = await Room.findOneAndUpdate(
                    { name: roomName },
                    { $setOnInsert: { name: roomName, type: 'channel' } },
                    { new: true, upsert: true }
                );

                let isBlockedByRecipient = false;
                let recipientUserId = null;

                if (targetRoom.type === 'direct' || targetRoom.type === 'secret') {
                    const recipientParticipant = targetRoom.participants.find(p => p.userId.toString() !== socket.userId.toString());

                    if (recipientParticipant) {
                        recipientUserId = recipientParticipant.userId;
                        const recipientUser = await User.findById(recipientUserId).select('blockedUsers');

                        if (recipientUser && recipientUser.blockedUsers && recipientUser.blockedUsers.some(b => b.toString() === socket.userId.toString())) {
                            isBlockedByRecipient = true;
                        }
                    }
                }

                const newMessage = new Message({
                    roomId: targetRoom._id,
                    senderId: user._id,
                    senderName: user.username,
                    type: data.type || 'text',
                    text: data.text,
                    imageUrl: data.imageUrl,
                    gifUrl: data.gifUrl,
                    audioUrl: data.audioUrl,
                    stickerData: data.stickerData,
                    isEphemeral: data.isEphemeral || false,
                    replyTo: data.replyTo,
                    status: 'sent',
                    fileSize: data.fileSize || 0,
                    fileFormat: data.fileFormat || 'text'
                });

                if (isBlockedByRecipient && recipientUserId) {
                    newMessage.deletedFor.push(recipientUserId);
                }

                const savedMessage = await newMessage.save();

                if (!isBlockedByRecipient) {
                    await Room.findByIdAndUpdate(targetRoom._id, { lastMessage: savedMessage._id });
                }

                const messagePayload = {
                    ...savedMessage.toObject(),
                    isSecretRoom: targetRoom.type === 'secret'
                };

                if (!isBlockedByRecipient) {
                    socket.to(roomName).emit('receive_message', messagePayload);
                } else {
                    socket.to(socket.userId.toString()).emit('receive_message', messagePayload);
                }

                if (typeof callback === 'function') {
                    callback({ success: true, status: 'sent', messageId: savedMessage._id, tempId: data.tempId });
                }

            } catch (error) {
                console.error('[MATRIX ERROR]: Failed to route message:', error);
                if (typeof callback === 'function') {
                    callback({ success: false, error: 'Message failed to send', tempId: data.tempId });
                }
            }
        });

        // Room Broadcasts
        socket.on('room_created', async (roomData) => {
            roomData.participants.forEach(participant => {
                if (participant.userId.toString() !== socket.userId.toString()) {
                    const targetSocketId = onlineUsers.get(participant.userId.toString());
                    if (targetSocketId) {
                        io.to(targetSocketId).emit('new_room_added', roomData);
                    }
                }
            });
        });

        // Read Receipts
        socket.on('mark_as_read', async ({ messageId, roomId }) => {
            await Message.findByIdAndUpdate(messageId, { status: 'read' });
            
            // FIX: Safely update lastReadTimestamp for individual read receipts
            const isObjectId = /^[0-9a-fA-F]{24}$/.test(roomId);
            const roomQuery = isObjectId ? { $or: [{ name: roomId }, { _id: roomId }] } : { name: roomId };

            await Room.updateOne(
                { ...roomQuery, "participants.userId": socket.userId },
                { $set: { "participants.$.lastReadTimestamp": new Date() } }
            );

            socket.to(roomId).emit('message_status_update', {
                messageId,
                status: 'read',
                readBy: socket.userId
            });
        });

        // Typing Indicators
        socket.on('typing_change', async ({ roomId, isTyping }) => {
            try {
                const sender = await User.findById(socket.userId).select('appearanceSettings username');
                if (sender.appearanceSettings?.privacyAndEffects?.hideTypingIndicator) return;

                socket.to(roomId).emit('user_typing', {
                    userId: socket.userId,
                    name: sender.username,
                    isTyping
                });
            } catch (error) {
                console.error("Typing Error:", error);
            }
        });

        // Message Deletion
        socket.on('delete_message', async ({ messageId, roomId }, callback) => {
            try {
                const message = await Message.findById(messageId);
                if (!message) return;

                const room = await Room.findOne({ name: roomId, "participants.userId": socket.userId });
                const isSender = message.senderId.toString() === socket.userId.toString();
                const isAdmin = room && room.participants.find(p => p.userId.toString() === socket.userId.toString())?.role === 'admin';

                if (!isSender && !isAdmin) return callback({ success: false, error: 'Unauthorized' });

                if (message.imageUrl && message.imageUrl.includes('cloudinary')) {
                    const publicId = `synced_uploads/${message.imageUrl.split('/').pop().split('.')[0]}`;
                    await cloudinary.uploader.destroy(publicId).catch(err => console.error("Cloudinary image scrub failed", err));
                }

                if (message.audioUrl && message.audioUrl.includes('cloudinary')) {
                    const publicId = `synced_audio/${message.audioUrl.split('/').pop().split('.')[0]}`;
                    await cloudinary.uploader.destroy(publicId, { resource_type: 'video' }).catch(err => console.error("Cloudinary audio scrub failed", err));
                }

                message.text = null;
                message.imageUrl = null;
                message.gifUrl = null;
                message.audioUrl = null;
                message.stickerData = null;
                message.reaction = null;
                message.isDeleted = true;
                await message.save();

                const targetRoom = await Room.findOne({ name: roomId });
                if (targetRoom && targetRoom.lastMessage && targetRoom.lastMessage.toString() === messageId.toString()) {
                    io.to(roomId).emit('room_preview_update', { roomId, text: '🚫 This message was deleted' });
                }

                io.to(roomId).emit('message_deleted', { messageId, roomId, cancelPush: true });
                if (callback) callback({ success: true });

            } catch (error) {
                console.error("[MATRIX ERROR] Deletion failed:", error);
            }
        });

        // Message Modification
        socket.on('edit_message', async ({ messageId, roomId, newText }, callback) => {
            try {
                const message = await Message.findById(messageId);
                if (!message || message.isDeleted) return;

                if (message.senderId.toString() !== socket.userId.toString()) return callback({ success: false, error: 'Unauthorized' });

                const timeDiffMins = (Date.now() - new Date(message.createdAt).getTime()) / (1000 * 60);
                if (timeDiffMins > 30) return callback({ success: false, error: 'Time limit exceeded' });

                message.text = newText;
                message.isEdited = true;
                await message.save();

                const targetRoom = await Room.findOne({ name: roomId });
                if (targetRoom && targetRoom.lastMessage && targetRoom.lastMessage.toString() === messageId.toString()) {
                    io.to(roomId).emit('room_preview_update', { roomId, text: newText });
                }

                io.to(roomId).emit('message_edited', { messageId, roomId, newText });
                if (callback) callback({ success: true });

            } catch (error) {
                console.error("[MATRIX ERROR] Edit failed:", error);
            }
        });

        // Message Reactions
        socket.on('add_reaction', async ({ messageId, roomId, emoji }) => {
            await Message.findByIdAndUpdate(messageId, { reaction: emoji });

            socket.to(roomId).emit('reaction_updated', {
                messageId,
                emoji,
                userId: socket.userId
            });
        });

        // Message Forwarding
        socket.on('forward_message', async ({ messageId, targetRoomIds }, callback) => {
            try {
                if (!targetRoomIds || targetRoomIds.length === 0 || targetRoomIds.length > 5) {
                    return callback({ success: false, error: 'Cannot forward to more than 5 rooms at once.' });
                }

                const originalMsg = await Message.findById(messageId).populate('roomId');
                if (!originalMsg) return callback({ success: false, error: 'Message not found.' });

                if (originalMsg.isEphemeral) {
                    return callback({ success: false, error: 'Ephemeral messages cannot be forwarded.' });
                }

                const isOriginSecret = originalMsg.roomId.type === 'secret';
                const sender = await User.findById(socket.userId);

                originalMsg.forwardCount = (originalMsg.forwardCount || 0) + 1;
                await originalMsg.save();

                let successCount = 0;
                let failureCount = 0;

                const forwardPromises = targetRoomIds.map(async (targetId) => {
                    try {
                        const targetRoom = await Room.findById(targetId);
                        if (!targetRoom) { failureCount++; return; }

                        if (isOriginSecret && targetRoom.type !== 'secret') {
                            failureCount++;
                            return;
                        }

                        const cloneMsg = new Message({
                            roomId: targetRoom._id,
                            senderId: sender._id,
                            senderName: sender.username,
                            type: originalMsg.type,
                            text: originalMsg.text,
                            imageUrl: originalMsg.imageUrl,
                            gifUrl: originalMsg.gifUrl,
                            audioUrl: originalMsg.audioUrl,
                            stickerData: originalMsg.stickerData,
                            isForwarded: true,
                            forwardCount: originalMsg.forwardCount,
                            originalSenderName: originalMsg.originalSenderName || originalMsg.senderName,
                            status: 'sent'
                        });

                        const savedClone = await cloneMsg.save();

                        await Room.findByIdAndUpdate(targetRoom._id, { lastMessage: savedClone._id });

                        socket.to(targetRoom.name).emit('receive_message', savedClone);
                        socket.emit('receive_message', savedClone);

                        successCount++;
                    } catch (e) {
                        console.error('Clone failed for room:', targetId, e);
                        failureCount++;
                    }
                });

                await Promise.all(forwardPromises);

                if (typeof callback === 'function') {
                    callback({ success: true, successCount, failureCount });
                }

            } catch (error) {
                console.error("[MATRIX ERROR] Forwarding failed:", error);
                if (typeof callback === 'function') {
                    callback({ success: false, error: 'Server error during forwarding.' });
                }
            }
        });

        // Synchronization
        socket.on('sync_missed_messages', async ({ roomId, lastMessageId }) => {
            try {
                let resolvedRoomId = roomId;
            
                if (typeof roomId === 'string' && roomId.includes('-')) {
                    const roomDoc = await Room.findOne({ name: roomId });
                    if (!roomDoc) return;
                    resolvedRoomId = roomDoc._id;
                }

                const lastMessage = await Message.findById(lastMessageId);
                if (!lastMessage) return;

                const missedMessages = await Message.find({
                    roomId: resolvedRoomId,
                    createdAt: { $gt: lastMessage.createdAt }
                }).sort({ createdAt: 1 }); 

                if (missedMessages.length > 0) {
                    socket.emit('missed_messages_payload', { roomId, messages: missedMessages });
                }
            } catch (error) {
                console.error('[MATRIX WARN] Error syncing missed messages:', error.message);
            }
        });

        // Delivery Confirmation
        socket.on('message_delivered', async ({ messageId, roomId }) => {
            await Message.findByIdAndUpdate(messageId, { status: 'delivered' });
            socket.to(roomId).emit('message_status_update', { messageId, status: 'delivered' });
        });

        // Bulk Read Status
        socket.on('mark_room_as_read', async ({ roomId }) => {
            try {
                // FIX: Support Room ID and Room Name dynamically
                const isObjectId = /^[0-9a-fA-F]{24}$/.test(roomId);
                const roomQuery = isObjectId ? { $or: [{ name: roomId }, { _id: roomId }] } : { name: roomId };
                const room = await Room.findOne(roomQuery);
                if (!room) return;

                await Message.updateMany(
                    { roomId: room._id, senderId: { $ne: socket.userId }, status: { $ne: 'read' } },
                    { $set: { status: 'read' } }
                );

                // FIX: Explicitly update the lastReadTimestamp to prevent backend desyncs
                await Room.updateOne(
                    { _id: room._id, "participants.userId": socket.userId },
                    { $set: { "participants.$.lastReadTimestamp": new Date() } }
                );

                socket.to(roomId).emit('room_messages_read', { roomId });
            } catch (error) {
                console.error("Bulk read error:", error);
            }
        });

        // Call Matrix Handlers
        socket.on('start_call', async ({ roomId, targetUserId, type, isGroup }, callback) => {
            try {
                let isEmergencyBypass = false;

                if (!isGroup) {
                    const targetUser = await User.findById(targetUserId);
                    if (!targetUser) return callback({ success: false, error: 'User Unavailable' });

                    const isBlocked = targetUser.blockedUsers && targetUser.blockedUsers.some(b => b.toString() === socket.userId.toString());
                    if (isBlocked) {
                        return callback({ success: false, error: 'User Unavailable' });
                    }

                    const attemptKey = `${socket.userId}_${targetUserId}`;
                    const now = Date.now();

                    let attempts = recentCallAttempts.get(attemptKey) || [];
                    attempts = attempts.filter(time => now - time < BYPASS_WINDOW_MS);
                    attempts.push(now);
                    recentCallAttempts.set(attemptKey, attempts);

                    if (attempts.length >= REQUIRED_ATTEMPTS) {
                        isEmergencyBypass = true;
                        recentCallAttempts.delete(attemptKey);
                        console.log(`[NETWORK]: Emergency Bypass activated for ${targetUserId}`);
                    }

                    const prefs = targetUser.notificationSettings?.dnd || {};
                    let isOnDND = false;

                    if (prefs.isActive) {
                        if (!prefs.until || new Date(prefs.until) > new Date()) {
                            isOnDND = true;
                        }
                    }

                    if (isOnDND && !isEmergencyBypass) {
                        return callback({ success: false, error: 'User is currently on Do Not Disturb' });
                    }
                }

                const callLog = new CallLog({
                    roomId: roomId,
                    callerId: socket.userId,
                    type: type,
                    status: 'ongoing',
                    participants: isGroup
                        ? targetUserId.map(id => ({ userId: id, status: 'ringing' }))
                        : [{ userId: targetUserId, status: 'ringing' }]
                });
                await callLog.save();

                activeSocketCalls.set(socket.id, { callId: callLog._id, role: 'caller', targetUserId, roomId, isGroup });

                const payload = { callId: callLog._id, callerId: socket.userId, roomId, type, isEmergencyBypass };

                if (!isGroup) {
                    io.to(targetUserId.toString()).emit('incoming_call', payload);
                } else {
                    const systemMsg = {
                        _id: Date.now().toString(),
                        roomId: roomId,
                        type: 'system',
                        text: `📞 A ${type} huddle has started. Tap to join.`,
                        callMetadata: payload
                    };
                    io.to(roomId).emit('receive_message', systemMsg);
                    io.to(roomId).emit('group_call_started', payload);
                }

                callback({ success: true, callId: callLog._id });
            } catch (error) {
                console.error("Start call error:", error);
                callback({ success: false, error: 'Internal Server Error during signaling' });
            }
        });

        // Call State Modifiers
        socket.on('accept_call', async ({ callId, callerId }) => {
            try {
                await CallLog.findOneAndUpdate(
                    { _id: callId, 'participants.userId': socket.userId },
                    { $set: { 'participants.$.status': 'joined', 'participants.$.joinedAt': new Date() } }
                );

                activeSocketCalls.set(socket.id, { callId, role: 'receiver' });

                io.to(callerId.toString()).emit('call_answered', { callId, responderId: socket.userId });
                socket.broadcast.to(socket.userId.toString()).emit('call_answered_elsewhere', { callId });
            } catch (error) {
                console.error("Accept call error:", error);
            }
        });

        socket.on('reject_call', async ({ callId, callerId }) => {
            try {
                await CallLog.findOneAndUpdate(
                    { _id: callId, 'participants.userId': socket.userId },
                    { $set: { 'participants.$.status': 'declined' }, status: 'declined' }
                );

                io.to(callerId.toString()).emit('call_rejected', { callId, responderId: socket.userId });
                socket.broadcast.to(socket.userId.toString()).emit('call_answered_elsewhere', { callId }); 
                activeSocketCalls.delete(socket.id);
            } catch (error) {
                console.error("Reject call error:", error);
            }
        });

        // WebRTC Signaling
        socket.on('webrtc_signal', ({ targetUserId, signal, callId }) => {
            io.to(targetUserId.toString()).emit('webrtc_signal', {
                senderId: socket.userId,
                signal,
                callId
            });
        });

        // Call Termination
        socket.on('end_call', async ({ callId, targetUserId, durationInSeconds }) => {
            try {
                await CallLog.findByIdAndUpdate(callId, {
                    status: 'completed',
                    duration: durationInSeconds || 0 
                });

                if (targetUserId) {
                    io.to(targetUserId.toString()).emit('call_ended', { callId });
                }
                activeSocketCalls.delete(socket.id);
            } catch (error) {
                console.error("End call error:", error);
            }
        });

        // Status Read Receipts
        socket.on('status_viewed', async ({ statusId, targetUserId }) => {
            const targetSocketId = onlineUsers.get(targetUserId.toString());
            if (targetSocketId) {
                io.to(targetSocketId).emit('status_view_receipt', {
                    statusId,
                    viewedBy: socket.userId
                });
            }
        });

        // Disconnection Handling
        socket.on('disconnect', async () => {
            console.log(`User Disconnected: ${socket.userId}`);

            const activeCall = activeSocketCalls.get(socket.id);
            if (activeCall) {
                if (activeCall.role === 'caller' && !activeCall.isGroup) {
                    io.to(activeCall.targetUserId.toString()).emit('call_cancelled', { callId: activeCall.callId });
                    await CallLog.findByIdAndUpdate(activeCall.callId, { status: 'missed' });
                } else if (activeCall.role === 'receiver') {
                    io.to(activeCall.callerId.toString()).emit('call_ended', { callId: activeCall.callId });
                }
                activeSocketCalls.delete(socket.id);
            }
            console.log(`[NETWORK]: User ${socket.userId} disconnected.`);

            onlineUsers.delete(socket.userId.toString());
            await User.findByIdAndUpdate(socket.userId, {
                isOnline: false,
                lastSeen: new Date()
            });

            socket.broadcast.emit('user_status_change', {
                userId: socket.userId,
                isOnline: false,
                lastSeen: new Date()
            });
        });
    });
};