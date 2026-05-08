const mongoose = require('mongoose');

const ReservedUsernameSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true, lowercase: true },
    originalOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    lockedUntil: { type: Date, required: true }
});

// Automatically delete the document when the lock expires using a TTL index
ReservedUsernameSchema.index({ lockedUntil: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ReservedUsername', ReservedUsernameSchema);