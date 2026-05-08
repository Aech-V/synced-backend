const mongoose = require('mongoose');

const PasskeySchema = new mongoose.Schema({
    credentialID: { type: String, required: true },
    publicKey: { type: String, required: true },
    counter: { type: Number, required: true },
    deviceType: { type: String },
    transports: [{ type: String }]
}, { _id: false });

const SessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true },
    refreshToken: { type: String, required: true },
    device: { type: String, default: 'Unknown Device' },
    os: { type: String, default: 'Unknown' },
    location: { type: String, default: 'Unknown Location' },
    lastActive: { type: Date, default: Date.now }
});

const UserSchema = new mongoose.Schema({
    // Core Credentials
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: false }, // Made optional to support Passkey/SSO-only accounts
    currentChallenge: { type: String },

    // --- NEW: THE HYBRID IDENTITY ENGINE ---
    // Raw phone is optional, used for WebOTP and account recovery
    // FIX: Kept the primary definition with necessary indexes and constraints
    phoneNumber: { type: String, sparse: true, unique: true },
    // A one-way SHA-256 hash of the normalized phone number. 
    // The frontend hashes the local contact book, sends the hashes to the server, 
    // and the server silently returns matching profiles without ever seeing raw numbers.
    phoneHash: { type: String, sparse: true, index: true }, 

    // Profile Engine
    avatar: { type: String, default: '' },
    about: { type: String, default: 'Available' },
    // FIX: Removed duplicate phoneNumber definition from here

    // WebAuthn / Passkey Engine
    passkeys: [PasskeySchema],

    // Session Management (For the Security Tab)
    activeSessions: [SessionSchema],
    // Privacy Engine State
    privacySettings: {
        lastSeen: { type: String, enum: ['everyone', 'contacts', 'except', 'nobody'], default: 'contacts' },
        readReceipts: { type: Boolean, default: true },
        exclusionList: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Legacy naming kept for Last Seen

        // New Premium Privacy Fields
        profilePhoto: { type: String, enum: ['everyone', 'contacts', 'except', 'nobody'], default: 'everyone' },
        profilePhotoExclusions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

        groupAdds: { type: String, enum: ['everyone', 'contacts', 'except', 'nobody'], default: 'everyone' },
        groupAddExclusions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
    },

    // Security & 2FA Engine
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String },
    failed2FAAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date },

    // App Lock Engine
    appLock: {
        enabled: { type: Boolean, default: false },
        pin: { type: String }, // Fallback PIN
        timeout: { type: String, enum: ['immediately', '1min', '5mins'], default: 'immediately' },
        scope: { type: String, enum: ['local', 'global'], default: 'local' }
    },

    // --- PHASE 1: TRUST, SAFETY & UI PREFERENCES ---
    blockedUsers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    mutedChats: [{
        roomId: { type: String, required: true },
        mutedUntil: { type: Date, required: true }
    }],
    starredMessages: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message'
    }],

    // --- PHASE 1: E2E CRYPTOGRAPHY (PUBLIC KEYS) ---
    e2eKeys: {
        identityKey: { type: String, default: null },   // Public Identity Key
        signedPreKey: { type: String, default: null },  // Public Signed Pre-Key
        oneTimePreKeys: [{ type: String }]              // Pool of One-Time Pre-Keys
    },

    notificationSettings: {
        push: { type: Boolean, default: true },
        email: { type: Boolean, default: false },
        messageSounds: { type: Boolean, default: true },
        callSounds: { type: Boolean, default: true },
        dnd: {
            isActive: { type: Boolean, default: false },
            until: { type: Date, default: null },
            scope: { type: String, enum: ['global', 'local'], default: 'global' }
        },
        quietHours: {
            enabled: { type: Boolean, default: false },
            start: { type: String, default: '22:00' },
            end: { type: String, default: '07:00' }
        },
        customOverrides: [{
            roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
            soundFile: { type: String, default: 'default' },
            isMuted: { type: Boolean, default: false }
        }]
    },

    // Network & Storage Engine
    storageSettings: {
        autoDownload: {
            photos: { type: String, enum: ['never', 'wifi', 'wifi_cellular'], default: 'wifi_cellular' },
            videos: { type: String, enum: ['never', 'wifi', 'wifi_cellular'], default: 'wifi' },
            audio: { type: String, enum: ['never', 'wifi', 'wifi_cellular'], default: 'wifi_cellular' },
            docs: { type: String, enum: ['never', 'wifi', 'wifi_cellular'], default: 'wifi' }
        },
        lowDataMode: { type: Boolean, default: false },
        retentionPolicy: { type: String, enum: ['30_days', '1_year', 'forever'], default: 'forever' }
    },
    networkStats: {
        bytesSent: { type: Number, default: 0 },
        bytesReceived: { type: Number, default: 0 },
        lastReset: { type: Date, default: Date.now }
    },

    appearanceSettings: {
        theme: { type: String, enum: ['light', 'dark', 'oled', 'system'], default: 'system' },
        accentColor: { type: String, default: '#FCCB06' },

        chatCustomization: {
            wallpaperDimming: { type: Number, default: 0, min: 0, max: 100 },
            bubbleShape: { type: String, enum: ['classic', 'rounded', 'squircle'], default: 'rounded' },
            showBubbleTail: { type: Boolean, default: true },
            bubbleTransparency: { type: Boolean, default: false } // Glassmorphism toggle
        },

        typography: {
            fontScale: { type: Number, default: 100, min: 70, max: 150 }, // 70% to 150%
            fontFamily: { type: String, enum: ['system', 'Tangerine', 'Audiowide', 'Felipa'], default: 'system' },
            highContrast: { type: Boolean, default: false }
        },

        layout: {
            chatListDensity: { type: String, enum: ['comfortable', 'compact'], default: 'comfortable' },
            navPosition: { type: String, enum: ['bottom', 'top'], default: 'bottom' },
            archivedStyle: { type: String, enum: ['hidden', 'pinned'], default: 'pinned' }
        },

        media: {
            appIcon: { type: String, default: 'classic' },
            previewSize: { type: String, enum: ['large', 'grid'], default: 'large' }
        },

        privacyAndEffects: {
            ghostNotifications: { type: Boolean, default: false },
            hideTypingIndicator: { type: Boolean, default: false }, // Bidirectional
            readReceiptColor: { type: String, enum: ['grey', 'accent'], default: 'accent' },
            reducedMotion: { type: Boolean, default: false },
            parallaxEffects: { type: Boolean, default: true }
        }
    },

    location: { type: String, default: '' },
    socialLink: { type: String, default: '' },

    // Expiring Status Engine
    currentStatus: {
        text: { type: String, default: '' },
        expiresAt: { type: Date, default: null }
    },

    // Avatar History (Max 2 past avatars)
    pastAvatars: [{
        url: { type: String, required: true },
        addedAt: { type: Date, default: Date.now }
    }],

    // Activity
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);