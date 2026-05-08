const mongoose = require('mongoose');

const statusSchema = new mongoose.Schema({
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true 
    },
    mediaUrl: { type: String, required: true },
    mediaPublicId: { type: String }, // CRITICAL: Required for Cloudinary deletion
    mediaType: { type: String, enum: ['image', 'video'], default: 'image' },
    caption: { type: String, default: '' },
    
    // Read Receipts
    viewers: [{ 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User' 
    }],
    
    // Privacy Engine
    privacyLevel: { 
        type: String, 
        enum: ['everyone', 'contacts', 'nobody'], 
        default: 'contacts' 
    },
    
    // Explicit Expiration Timestamp (Defaults to 24 hours from creation)
    expiresAt: { 
        type: Date, 
        required: true,
        default: () => new Date(Date.now() + 24 * 60 * 60 * 1000)
    }
}, { timestamps: true });

// Optional: Fallback MongoDB TTL Index (Cron job is primary, this is a safety net)
statusSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Status', statusSchema);