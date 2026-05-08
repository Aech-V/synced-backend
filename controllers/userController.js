const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Room = require('../models/Room');
const Message = require('../models/Message');
const Ticket = require('../models/Ticket');
const ReservedUsername = require('../models/ReservedUsername');
const Otp = require('../models/Otp');
const { authenticator } = require('otplib');
const { cloudinary } = require('../config/cloudinary'); // Added Cloudinary import

// @desc Search for users to add as contacts
// @route GET /api/users/search
exports.searchUsers = async (req, res) => {
    try {
        const query = req.query.q;
        const users = await User.find({
            username: { $regex: query, $options: 'i' },
            _id: { $ne: req.user.id }
        })
            .select('username avatar about isOnline')
            .limit(10);
        res.status(200).json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to search users' });
    }
};

// @desc Update public profile
// @route PUT /api/users/profile
exports.updateProfile = async (req, res) => {
    try {
        const { username, about, location, socialLink, currentStatus, avatar, phoneNumber } = req.body;
        const user = await User.findById(req.user.id);

        if (username && username !== user.username) {
            const lockDate = new Date();
            lockDate.setDate(lockDate.getDate() + 7);

            await ReservedUsername.create({
                username: user.username.toLowerCase(),
                originalOwner: user._id,
                lockedUntil: lockDate
            });
            user.username = username;
        }

        if (avatar && avatar !== user.avatar) {
            if (user.avatar) {
                user.pastAvatars.unshift({ url: user.avatar, addedAt: new Date() });
                if (user.pastAvatars.length > 2) user.pastAvatars.pop();
            }
            user.avatar = avatar;
        }

        if (about !== undefined) user.about = about;
        if (location !== undefined) user.location = location;
        if (socialLink !== undefined) user.socialLink = socialLink;
        if (currentStatus) user.currentStatus = currentStatus;
        if (phoneNumber) user.phoneNumber = phoneNumber;

        await user.save();
        res.status(200).json({ message: 'Profile updated securely', user });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update profile' });
    }
};

// @desc Update privacy engine settings
// @route PUT /api/users/privacy
exports.updatePrivacySettings = async (req, res) => {
    try {
        const { lastSeen, readReceipts, exclusionList, profilePhoto, profilePhotoExclusions, groupAdds, groupAddExclusions } = req.body;
        const user = await User.findById(req.user.id);
        
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (lastSeen) user.privacySettings.lastSeen = lastSeen;
        if (typeof readReceipts === 'boolean') user.privacySettings.readReceipts = readReceipts;
        if (exclusionList) user.privacySettings.exclusionList = exclusionList;
        if (profilePhoto) user.privacySettings.profilePhoto = profilePhoto;
        if (profilePhotoExclusions) user.privacySettings.profilePhotoExclusions = profilePhotoExclusions;
        if (groupAdds) user.privacySettings.groupAdds = groupAdds;
        if (groupAddExclusions) user.privacySettings.groupAddExclusions = groupAddExclusions;

        await user.save();
        res.status(200).json({ message: 'Privacy settings updated', privacySettings: user.privacySettings });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update privacy settings' });
    }
};

// @desc Update advanced notification settings
// @route PUT /api/users/notifications
exports.updateNotificationSettings = async (req, res) => {
    try {
        const { notificationSettings } = req.body;
        if (!notificationSettings) return res.status(400).json({ error: 'Notification settings data is required' });

        const user = await User.findByIdAndUpdate(
            req.user.id,
            { $set: { notificationSettings: notificationSettings } },
            { new: true, runValidators: true }
        ).select('notificationSettings');

        if (!user) return res.status(404).json({ error: 'User not found' });

        res.status(200).json({ message: 'Notification settings updated', notificationSettings: user.notificationSettings });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update notification settings' });
    }
};

// @desc Get all rooms excluding secret chats
// @route GET /api/users/rooms
exports.getUserRooms = async (req, res) => {
    try {
        const currentUser = await User.findById(req.user.id);
        const rooms = await Room.find({
            type: { $ne: 'secret' },
            $or: [{ type: 'channel' }, { 'participants.userId': req.user.id }]
        })
            .populate('lastMessage')
            .populate('participants.userId', 'username avatar isOnline lastSeen')
            .sort({ updatedAt: -1 })
            .lean();

        const roomsWithData = await Promise.all(rooms.map(async (room) => {
            const participant = room.participants.find(p => p.userId && p.userId._id.toString() === req.user.id);
            const lastRead = participant?.lastReadTimestamp ? new Date(participant.lastReadTimestamp) : new Date(0);

            const unreadCount = await Message.countDocuments({
                roomId: room._id,
                createdAt: { $gt: lastRead },
                senderId: { $ne: req.user.id },
                type: { $ne: 'system' }
            });

            const hasMention = await Message.exists({
                roomId: room._id,
                createdAt: { $gt: lastRead },
                text: { $regex: `@${currentUser.username}`, $options: 'i' }
            });

            return { ...room, unreadCount, hasMention: !!hasMention, isMuted: participant?.isMuted || false };
        }));

        res.status(200).json(roomsWithData);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch rooms' });
    }
};

// @desc Submit a new support ticket
// @route POST /api/users/support
exports.submitSupportTicket = async (req, res) => {
    try {
        const { subject, category, priority, message, attachments, deviceInfo } = req.body;

        if (!subject || !category || !priority || !message) {
            return res.status(400).json({ error: 'Please fill out all required fields.' });
        }

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const ticketCountToday = await Ticket.countDocuments({ userId: req.user.id, createdAt: { $gte: startOfDay } });

        if (ticketCountToday >= 3) {
            return res.status(429).json({ error: 'Daily limit reached. Please wait 24 hours.' });
        }

        const user = await User.findById(req.user.id);

        const newTicket = await Ticket.create({
            userId: user._id,
            email: user.email,
            subject, category, priority, message,
            attachments: attachments || [],
            deviceInfo: deviceInfo || {}
        });

        res.status(201).json({ message: 'Ticket submitted successfully', ticketId: newTicket._id });
    } catch (error) {
        res.status(500).json({ error: 'Failed to submit support ticket.' });
    }
};

// @desc Get all support tickets for logged-in user
// @route GET /api/users/support
exports.getUserTickets = async (req, res) => {
    try {
        const tickets = await Ticket.find({ userId: req.user.id }).sort({ createdAt: -1 }).select('-deviceInfo');
        res.status(200).json(tickets);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch support tickets.' });
    }
};

// @desc Check username availability in real-time
// @route GET /api/users/check-username
exports.checkUsernameAvailability = async (req, res) => {
    try {
        const targetUsername = req.query.u?.toLowerCase();

        const isValid = /^[a-zA-Z0-9_]+$/.test(targetUsername) && !targetUsername.endsWith('_');
        if (!isValid || targetUsername.length < 3 || targetUsername.length > 15) {
            return res.status(400).json({ available: false, error: 'Invalid format.' });
        }

        const bannedWords = ['admin', 'support', 'system', 'synced', 'official'];
        if (bannedWords.some(word => targetUsername.includes(word))) {
            return res.status(400).json({ available: false, error: 'Username is reserved.' });
        }

        const userExists = await User.exists({ username: new RegExp(`^${targetUsername}$`, 'i') });
        if (userExists) return res.status(200).json({ available: false, error: 'Username taken.' });

        const isReserved = await ReservedUsername.findOne({ username: targetUsername });
        if (isReserved && isReserved.originalOwner.toString() !== req.user.id) {
            return res.status(200).json({ available: false, error: 'Username temporarily locked.' });
        }

        res.status(200).json({ available: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to verify username' });
    }
};

// @desc Send OTP to phone number
// @route POST /api/users/send-otp
exports.sendPhoneOtp = async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required.' });

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        await Otp.deleteMany({ userId: req.user.id });
        await Otp.create({ userId: req.user.id, phoneNumber, code });

        res.status(200).json({ message: 'Verification code sent.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send verification code.' });
    }
};

// @desc Verify phone OTP code
// @route POST /api/users/verify-otp
exports.verifyPhoneOtp = async (req, res) => {
    try {
        const { phoneNumber, code } = req.body;
        const validOtp = await Otp.findOne({ userId: req.user.id, phoneNumber, code });

        if (!validOtp) return res.status(400).json({ error: 'Invalid or expired verification code.' });

        await Otp.deleteMany({ userId: req.user.id });
        res.status(200).json({ message: 'Phone number verified successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Verification failed.' });
    }
};

// @desc Upload user avatar to Cloudinary
// @route POST /api/users/upload-avatar
exports.uploadAvatar = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image file provided' });

        const uploadOptions = {
            folder: 'synced_avatars',
            resource_type: 'image'
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
            // Feed the buffer from memoryStorage directly into the Cloudinary stream
            stream.end(req.file.buffer);
        });

        res.status(200).json({ mediaUrl: result.secure_url });
    } catch (error) {
        console.error('Avatar upload error:', error);
        res.status(500).json({ error: 'Failed to upload avatar' });
    }
};

// @desc Block a user
// @route POST /api/users/block
exports.blockUser = async (req, res) => {
    try {
        const { targetUserId } = req.body;
        if (targetUserId === req.user.id) return res.status(400).json({ error: "Cannot block yourself." });

        const user = await User.findById(req.user.id);
        const isAlreadyBlocked = user.blockedUsers.some(b => b.userId.toString() === targetUserId);
        
        if (isAlreadyBlocked) return res.status(400).json({ error: "User is already blocked." });

        user.blockedUsers.push({ userId: targetUserId, blockedAt: new Date() });
        await user.save();

        res.status(200).json({ message: 'User blocked successfully.', blockedUsers: user.blockedUsers });
    } catch (error) {
        res.status(500).json({ error: 'Failed to block user.' });
    }
};

// @desc Unblock a user
// @route POST /api/users/unblock
exports.unblockUser = async (req, res) => {
    try {
        const { targetUserId } = req.body;
        const user = await User.findById(req.user.id);

        user.blockedUsers = user.blockedUsers.filter(b => b.userId.toString() !== targetUserId);
        await user.save();

        res.status(200).json({ message: 'User unblocked successfully.', blockedUsers: user.blockedUsers });
    } catch (error) {
        res.status(500).json({ error: 'Failed to unblock user.' });
    }
};

// @desc Get populated list of blocked contacts
// @route GET /api/users/blocked
exports.getBlockedContacts = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).populate({
            path: 'blockedUsers.userId',
            select: 'username avatar about location'
        });
        res.status(200).json(user.blockedUsers);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch blocked contacts.' });
    }
};

// @desc Generate 2FA Secret
// @route GET /api/users/security/2fa/setup
exports.setup2FA = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        const secret = authenticator.generateSecret();
        const otpauthUrl = authenticator.keyuri(user.email, 'Synced App', secret);
        
        user.twoFactorSecret = secret;
        await user.save();
        res.status(200).json({ otpauthUrl });
    } catch (error) { 
        res.status(500).json({ error: 'Failed to generate 2FA' }); 
    }
};

// @desc Verify and Enable 2FA
// @route POST /api/users/security/2fa/enable
exports.enable2FA = async (req, res) => {
    try {
        const { otp } = req.body;
        const user = await User.findById(req.user.id);
        
        const isValid = authenticator.verify({ token: otp, secret: user.twoFactorSecret });
        if (!isValid) return res.status(400).json({ error: 'Invalid code.' });

        user.twoFactorEnabled = true;
        await user.save();
        res.status(200).json({ message: '2FA successfully enabled.' });
    } catch (error) { 
        res.status(500).json({ error: 'Failed to enable 2FA' }); 
    }
};

// @desc Disable 2FA
// @route POST /api/users/security/2fa/disable
exports.disable2FA = async (req, res) => {
    try {
        const { otp } = req.body;
        const user = await User.findById(req.user.id);
        
        const isValid = authenticator.verify({ token: otp, secret: user.twoFactorSecret });
        if (!isValid) return res.status(400).json({ error: 'Invalid code.' });

        user.twoFactorEnabled = false;
        user.twoFactorSecret = undefined;
        await user.save();
        res.status(200).json({ message: '2FA successfully disabled.' });
    } catch (error) { 
        res.status(500).json({ error: 'Failed to disable 2FA' }); 
    }
};

// @desc Get Active Sessions
// @route GET /api/users/sessions
exports.getSessions = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('activeSessions');
        const safeSessions = user.activeSessions.map(s => ({
            id: s._id,
            sessionId: s.sessionId,
            device: s.device,
            os: s.os,
            location: s.location,
            lastActive: s.lastActive
        }));
        res.status(200).json(safeSessions);
    } catch (error) { 
        res.status(500).json({ error: 'Failed to load sessions' }); 
    }
};

// @desc Revoke a specific session
// @route DELETE /api/users/sessions/:sessionId
exports.revokeSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        await User.findByIdAndUpdate(req.user.id, { $pull: { activeSessions: { sessionId: sessionId } } });
        res.status(200).json({ message: 'Session revoked' });
    } catch (error) { 
        res.status(500).json({ error: 'Failed to revoke session' }); 
    }
};

// @desc Revoke all OTHER sessions
// @route POST /api/users/sessions/revoke-all
exports.revokeAllOtherSessions = async (req, res) => {
    try {
        const { currentSessionId } = req.body;
        const user = await User.findById(req.user.id);
        
        user.activeSessions = user.activeSessions.filter(s => s.sessionId === currentSessionId);
        await user.save();
        res.status(200).json({ message: 'All other sessions revoked' });
    } catch (error) { 
        res.status(500).json({ error: 'Failed to revoke sessions' }); 
    }
};

// @desc Update App Lock Settings with Bcrypt hashing
// @route PUT /api/users/security/app-lock
exports.updateAppLockSettings = async (req, res) => {
    try {
        const { enabled, pin, timeout, scope } = req.body;
        const user = await User.findById(req.user.id);

        if (enabled !== undefined) user.appLock.enabled = enabled;
        if (timeout) user.appLock.timeout = timeout;
        if (scope) user.appLock.scope = scope;

        if (pin) {
            const salt = await bcrypt.genSalt(10);
            user.appLock.pin = await bcrypt.hash(pin, salt);
        }

        await user.save();
        res.status(200).json({ message: 'App Lock updated', appLock: user.appLock });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update App Lock' });
    }
};

// @desc Get Real-time Storage using pre-calculated metrics
// @route GET /api/users/storage
exports.getStorageStats = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('networkStats storageSettings storageMetrics');
        
        const metrics = user.storageMetrics || {
            totalUsed: 0,
            used: { video: 0, image: 0, document: 0, audio: 0 },
            topRooms: []
        };
        
        const totalQuotaBytes = 1073741824;

        res.status(200).json({ 
            quota: totalQuotaBytes, 
            totalUsed: metrics.totalUsed, 
            used: metrics.used, 
            topRooms: metrics.topRooms,
            networkStats: user.networkStats,
            settings: user.storageSettings
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to calculate storage' });
    }
};

// @desc Clear Media Cache
// @route DELETE /api/users/storage/clear-cache
exports.clearMediaCache = async (req, res) => {
    try {
        const userId = req.user.id;
        const userRooms = await Room.find({ 'participants.userId': userId }).select('_id');
        const roomIds = userRooms.map(r => r._id);

        await Message.updateMany(
            { roomId: { $in: roomIds }, fileSize: { $gt: 0 }, type: { $in: ['video', 'image', 'audio', 'document'] } },
            { $addToSet: { deletedFor: userId } }
        );

        res.status(200).json({ message: 'Cache cleared successfully. Media blurred.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to clear cache' });
    }
};

// @desc Update Premium Appearance Settings
// @route PUT /api/users/appearance
exports.updateAppearanceSettings = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        
        user.appearanceSettings = {
            ...user.appearanceSettings.toObject(),
            ...req.body
        };

        await user.save();
        res.status(200).json({ message: 'Appearance synced to cloud', settings: user.appearanceSettings });
    } catch (error) {
        res.status(500).json({ error: 'Failed to save appearance settings' });
    }
};