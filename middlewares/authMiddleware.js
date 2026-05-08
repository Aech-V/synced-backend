const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Bounded LRU Cache for sessions
const sessionCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 10000;

// Periodic garbage collection to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of sessionCache.entries()) {
        if (now - value.timestamp >= CACHE_TTL) {
            sessionCache.delete(key);
        }
    }
}, 10 * 60 * 1000).unref();

exports.protect = async (req, res, next) => {
    let token = req.header('Authorization');

    if (token && token.startsWith('Bearer')) {
        token = token.split(' ')[1];
    }

    if (!token) {
        return res.status(401).json({ error: 'Not authorized to access this route' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const currentTime = Date.now();
        
        let cachedData = sessionCache.get(decoded.userId);
        let user;

        if (cachedData && (currentTime - cachedData.timestamp < CACHE_TTL)) {
            user = cachedData.user;
        } else {
            user = await User.findById(decoded.userId).select('activeSessions lockUntil');
            if (user) {
                if (sessionCache.size >= MAX_CACHE_SIZE) {
                    const oldestKey = sessionCache.keys().next().value;
                    sessionCache.delete(oldestKey);
                }
                sessionCache.set(decoded.userId, { user, timestamp: currentTime });
            }
        }
        
        if (!user) {
            sessionCache.delete(decoded.userId);
            return res.status(401).json({ error: 'The user belonging to this token no longer exists.' });
        }

        if (user.lockUntil && user.lockUntil > currentTime) {
            return res.status(403).json({ error: 'Account is temporarily locked. Please try again later.' });
        }

        if (decoded.sessionId) {
            const isSessionValid = user.activeSessions.some(session => session.sessionId === decoded.sessionId);
            if (!isSessionValid) {
                return res.status(401).json({ error: 'This session has been revoked. Please log in again.' });
            }
        }

        req.user = { id: decoded.userId };
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token has expired' });
        }
        res.status(401).json({ error: 'Token is invalid' });
    }
};