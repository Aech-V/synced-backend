const mongoose = require('mongoose');

const OtpSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    phoneNumber: { type: String, required: true },
    code: { type: String, required: true },
    // This TTL index tells MongoDB to automatically delete the doc after 300 seconds (5 mins)
    createdAt: { type: Date, default: Date.now, expires: 300 } 
});

module.exports = mongoose.model('Otp', OtpSchema);