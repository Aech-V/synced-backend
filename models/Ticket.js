const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reportedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    
    // Level 1: Primary Category
    category: { 
        type: String, 
        enum: ['Spam', 'Harassment', 'Harmful Content', 'Other'], 
        required: true 
    },
    
    // Level 2: Specific Sub-Category
    subCategory: { 
        type: String,
        enum: [
            'Commercial', 'Phishing', // Spam
            'Bullying', 'Threats', // Harassment
            'Self-harm', 'Child Safety', 'Hate Speech', 'Drugs', 'Weapons', 'CSAM', // Harmful
            'Impersonation', 'Scams', 'Other' // Fraud/Other
        ]
    },
    
    status: { 
        type: String, 
        enum: ['Open', 'Under Review', 'Resolved', 'Dismissed'], 
        default: 'Open' 
    }
}, { timestamps: true });

module.exports = mongoose.model('Ticket', ticketSchema);