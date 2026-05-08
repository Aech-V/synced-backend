const mongoose = require('mongoose');

const ParticipantSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    // YOU MUST HAVE THIS LINE:
    clearedAt: { type: Date, default: () => new Date(0) }
}, { _id: false });

const RoomSchema = new mongoose.Schema({
    name: { type: String, required: true },
    type: { type: String, enum: ['direct', 'channel', 'group', 'secret'], required: true },
    participants: [ParticipantSchema],
    lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },

    // Metadata
    avatar: { type: String, default: '' },
    description: { type: String },

    // Secret Chat Vault features
    isSecret: { type: Boolean, default: false },
    password: { type: String }
}, { timestamps: true });

RoomSchema.index({ 'participants.userId': 1 });

module.exports = mongoose.model('Room', RoomSchema);