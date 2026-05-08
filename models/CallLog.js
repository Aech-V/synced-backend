const mongoose = require('mongoose');

const callLogSchema = new mongoose.Schema({
    roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
    callerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['voice', 'video'], required: true },
    
    // Global call status
    status: { type: String, enum: ['ongoing', 'completed', 'missed', 'declined'], default: 'ongoing' },
    duration: { type: Number, default: 0 },
    
    // Detailed participant tracking
    participants: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        status: { type: String, enum: ['ringing', 'joined', 'declined', 'missed'] },
        joinedAt: Date,
        leftAt: Date
    }],
    
    // Asymmetric deletion tracking
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

// Compound index for query optimization
callLogSchema.index({ callerId: 1, roomId: 1 });

// Ephemeral engine TTL index
callLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 5184000 });

module.exports = mongoose.model('CallLog', callLogSchema);