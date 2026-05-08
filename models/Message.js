const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderName: { type: String, required: true },
    
    // Payload routing
    type: { type: String, default: 'text' },
    text: { type: String },
    
    // Rich media URLs
    imageUrl: { type: String },
    gifUrl: { type: String },
    audioUrl: { type: String },
    
    // UI metadata
    stickerData: { type: Object },
    
    // Security and ephemeral engine
    isEphemeral: { type: Boolean, default: false },
    isBurned: { type: Boolean, default: false },
    burnedAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    isEdited: { type: Boolean, default: false },
    editedAt: { type: Date, default: null },
    isForwarded: { type: Boolean, default: false },
    forwardCount: { type: Number, default: 0 },
    originalSenderName: { type: String },

    // Storage engine additions
    fileSize: { type: Number, default: 0 },
    fileFormat: { type: String },
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    
    // Interactive chat features
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    reaction: { type: String },
    
    // Delivery status
    status: { type: String, default: 'sent' },

    // Advanced message types
    isE2E: { type: Boolean, default: false },
    replyToStatus: { type: String, default: null },
    pollData: {
        question: { type: String },
        options: [{
            text: { type: String },
            votes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
        }],
        expiresAt: { type: Date }
    },
    paymentData: {
        transactionId: { type: String },
        amount: { type: Number },
        status: { type: String, enum: ['pending', 'completed', 'failed'] }
    }
}, { timestamps: true });

// Cursor pagination index
MessageSchema.index({ roomId: 1, createdAt: -1 });

// Partial compound index for highly optimized media storage calculation
MessageSchema.index({ roomId: 1, deletedFor: 1, fileSize: 1 }, { partialFilterExpression: { fileSize: { $gt: 0 } } });

module.exports = mongoose.model('Message', MessageSchema);