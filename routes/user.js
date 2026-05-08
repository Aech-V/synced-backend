const express = require('express');
const { 
    searchUsers, updateProfile, updatePrivacySettings, getUserRooms, 
    updateNotificationSettings, submitSupportTicket, getUserTickets, checkUsernameAvailability, 
    sendPhoneOtp, verifyPhoneOtp, uploadAvatar,
    blockUser, unblockUser, getBlockedContacts, updateAppLockSettings,
    getStorageStats, clearMediaCache, updateAppearanceSettings,
    setup2FA, enable2FA, disable2FA, getSessions, revokeSession, revokeAllOtherSessions
} = require('../controllers/userController');

const { protect } = require('../middlewares/authMiddleware');
const { upload } = require('../config/cloudinary'); 

const router = express.Router();

// Public and contact discovery
router.get('/search', protect, searchUsers);
router.get('/check-username', protect, checkUsernameAvailability);

// Interaction and blocklists
router.get('/rooms', protect, getUserRooms);
router.post('/block', protect, blockUser);
router.post('/unblock', protect, unblockUser);
router.get('/blocked', protect, getBlockedContacts);

// Profile and UI personalization
router.put('/profile', protect, updateProfile);
router.post('/upload-avatar', protect, upload.single('avatar'), uploadAvatar); 
router.put('/appearance', protect, updateAppearanceSettings);

// User preferences
router.put('/privacy', protect, updatePrivacySettings);
router.put('/notifications', protect, updateNotificationSettings);

// Account security and 2FA
router.post('/send-otp', protect, sendPhoneOtp);
router.post('/verify-otp', protect, verifyPhoneOtp);
router.get('/security/2fa/setup', protect, setup2FA);
router.post('/security/2fa/enable', protect, enable2FA);
router.post('/security/2fa/disable', protect, disable2FA);
router.put('/security/app-lock', protect, updateAppLockSettings);

// Active session control
router.get('/sessions', protect, getSessions);
router.delete('/sessions/:sessionId', protect, revokeSession);
router.post('/sessions/revoke-all', protect, revokeAllOtherSessions);

// Storage engine
router.get('/storage', protect, getStorageStats);
router.delete('/storage/clear-cache', protect, clearMediaCache);

// Support
router.post('/support', protect, submitSupportTicket);
router.get('/support', protect, getUserTickets);

module.exports = router;