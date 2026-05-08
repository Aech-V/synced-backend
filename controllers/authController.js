const { generateRegistrationOptions, verifyRegistrationResponse } = require('@simplewebauthn/server');
const { generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const otplib = require('otplib');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const loginChallengeStore = new Map();

const authenticator = otplib.authenticator;
authenticator.options = { window: [1, 1] };

// WebAuthn configuration constants
const rpName = 'Synced Super-App';
const rpID = 'localhost';
const origin = `http://${rpID}:5173`;

// Helper to generate secure session
const generateSession = async (user, req) => {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const refreshToken = jwt.sign({ userId: user._id, sessionId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const accessToken = jwt.sign({ userId: user._id, sessionId }, process.env.JWT_SECRET, { expiresIn: '15m' });

    const newSession = {
        sessionId,
        refreshToken,
        device: req.body.deviceInfo?.device || 'Unknown Device',
        os: req.body.deviceInfo?.os || 'Unknown OS',
        location: req.body.deviceInfo?.location || 'Unknown Location',
        lastActive: new Date()
    };

    user.activeSessions.push(newSession);
    if (user.activeSessions.length > 3) {
        user.activeSessions.shift(); 
    }
    
    await user.save();
    
    return { 
        accessToken, 
        refreshToken, 
        sessionId,
        user: { 
            id: user._id, 
            username: user.username, 
            email: user.email,
            hasPasskey: user.passkeys && user.passkeys.length > 0
        } 
    };
};

// @desc    Rate limiter for account registration
// @route   Middleware
exports.registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { message: 'Too many accounts created from this IP, please try again after an hour.' }
});

// @desc    Rate limiter for login and OTP requests
// @route   Middleware
exports.loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { message: 'Too many login attempts from this IP, please try again after 15 minutes.' }
});

// @desc    Register a new user
// @route   POST /api/auth/register
exports.registerUser = async (req, res) => {
    try {
        const { username, email, password, e2eKeys } = req.body;

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: 'User already exists with this email.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({
            username,
            email,
            password: hashedPassword,
            e2eKeys: {
                identityKey: e2eKeys?.identityKey || null,
                signedPreKey: e2eKeys?.signedPreKey || null,
                oneTimePreKeys: e2eKeys?.oneTimePreKeys || []
            }
        });

        await newUser.save();

        const token = jwt.sign({ userId: newUser._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

        res.status(201).json({
            message: 'User registered successfully',
            token,
            user: { id: newUser._id, username: newUser.username, email: newUser.email }
        });

    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ message: 'Server error during registration' });
    }
};

// @desc    Login an existing user
// @route   POST /api/auth/login
exports.loginUser = async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        
        if (!user) return res.status(400).json({ message: 'Invalid credentials' });

        if (user.lockUntil && user.lockUntil > Date.now()) {
            return res.status(403).json({ message: 'Account temporarily locked due to too many failed 2FA attempts. Try again later.' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

        if (user.twoFactorEnabled) {
            const tempToken = jwt.sign({ userId: user._id, pending2FA: true }, process.env.JWT_SECRET, { expiresIn: '5m' });
            return res.status(200).json({ requires2FA: true, tempToken, message: '2FA verification required' });
        }

        const sessionData = await generateSession(user, req);
        res.status(200).json({ message: 'Logged in successfully', ...sessionData });

    } catch (error) {
        res.status(500).json({ message: 'Server error during login' });
    }
};

// @desc    Request a frictionless Magic Link to Email
// @route   POST /api/auth/magic-link
exports.requestMagicLink = async (req, res) => {
    try {
        const { email } = req.body;
        const user = await User.findOne({ email });
        
        if (!user) return res.status(200).json({ message: 'If an account exists, a link was sent.' });

        res.status(200).json({ message: 'If an account exists, a link was sent.' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to process magic link request' });
    }
};

// @desc    Request SMS OTP for frictionless signup/login
// @route   POST /api/auth/otp/request
exports.requestPhoneOTP = async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        res.status(200).json({ message: 'OTP sent successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to send OTP' });
    }
};

// @desc    Verify 2FA during Login Flow
// @route   POST /api/auth/login/2fa
exports.verify2FALogin = async (req, res) => {
    try {
        const { tempToken, otp } = req.body;
        
        const decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
        if (!decoded.pending2FA) return res.status(401).json({ message: 'Invalid token payload' });

        const user = await User.findById(decoded.userId);
        const isValid = authenticator.verify({ token: otp, secret: user.twoFactorSecret });
        
        if (!isValid) {
            user.failed2FAAttempts += 1;
            if (user.failed2FAAttempts >= 5) {
                user.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
            }
            await user.save();
            return res.status(400).json({ message: 'Invalid 2FA code' });
        }

        user.failed2FAAttempts = 0;
        user.lockUntil = undefined;
        
        const sessionData = await generateSession(user, req);
        console.log(`[ALERT]: New Login detected for ${user.username} from ${sessionData.device}`);

        res.status(200).json({ message: '2FA Verified', ...sessionData });
    } catch (error) {
        res.status(500).json({ message: 'Verification failed' });
    }
};

// @desc    Ask Server for a Passkey Challenge
// @route   GET /api/auth/webauthn/generate-registration
exports.generateWebAuthnRegistration = async (req, res) => {
    try {
        const { userId } = req.query; 
        const user = await User.findById(userId);
        
        if (!user) return res.status(404).json({ error: 'User not found' });

        const options = await generateRegistrationOptions({
            rpName,
            rpID,
            userID: new Uint8Array(Buffer.from(user._id.toString())), 
            userName: user.username,
            excludeCredentials: user.passkeys.map(passkey => ({
                id: passkey.credentialID,
                type: 'public-key',
            })),
            authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'preferred',
            },
        });

        user.currentChallenge = options.challenge;
        await user.save();

        res.status(200).json(options);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to generate WebAuthn options' });
    }
};

// @desc    Verify the Biometric Signature and Save Passkey
// @route   POST /api/auth/webauthn/verify-registration
exports.verifyWebAuthnRegistration = async (req, res) => {
    try {
        const { userId, registrationResponse } = req.body;
        const user = await User.findById(userId);

        if (!user || !user.currentChallenge) {
            return res.status(400).json({ error: 'No active challenge found for user' });
        }

        const verification = await verifyRegistrationResponse({
            response: registrationResponse,
            expectedChallenge: user.currentChallenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
        });

        const { verified, registrationInfo } = verification;

        if (verified && registrationInfo) {
            const { id, publicKey, counter } = registrationInfo.credential;

            user.passkeys.push({
                credentialID: Buffer.from(id).toString('base64'),
                publicKey: Buffer.from(publicKey).toString('base64'),
                counter,
                transports: registrationResponse.response.transports || [],
            });

            user.currentChallenge = undefined;
            await user.save();

            return res.status(200).json({ verified: true, message: 'Passkey securely bound to account!' });
        }

        res.status(400).json({ verified: false, error: 'Cryptographic verification failed' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to verify passkey' });
    }
};

// @desc    Ask Server for a Passkey Login Challenge
// @route   GET /api/auth/webauthn/generate-authentication
exports.generateWebAuthnAuthentication = async (req, res) => {
    try {
        const options = await generateAuthenticationOptions({
            rpID,
            userVerification: 'preferred',
        });

        // Store challenge temporarily (expires in 5 mins to prevent memory leaks)
        loginChallengeStore.set(options.challenge, options.challenge);
        setTimeout(() => loginChallengeStore.delete(options.challenge), 300000);

        res.status(200).json(options);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to generate authentication options' });
    }
};

// @desc    Verify the Biometric Login Signature
// @route   POST /api/auth/webauthn/verify-authentication
exports.verifyWebAuthnAuthentication = async (req, res) => {
    try {
        const { authenticationResponse } = req.body;

        // 1. Reformat the incoming ID to match exactly how we saved it during Registration
        const searchId = Buffer.from(authenticationResponse.id).toString('base64');
        
        // 2. Discoverable Credential Magic: Find the user purely by their FaceID/TouchID signature!
        const user = await User.findOne({ "passkeys.credentialID": searchId });

        if (!user) {
            return res.status(404).json({ message: 'No account found matching this Passkey on this device.' });
        }

        const passkey = user.passkeys.find(pk => pk.credentialID === searchId);

        // 3. Extract the challenge from the client's payload to verify it wasn't forged
        const clientDataJSON = Buffer.from(authenticationResponse.response.clientDataJSON, 'base64').toString('utf8');
        const expectedChallenge = JSON.parse(clientDataJSON).challenge;

        // Verify the challenge was actually generated by OUR server recently
        if (!loginChallengeStore.has(expectedChallenge)) {
            return res.status(400).json({ message: 'Login request timed out. Please click Passkey again.' });
        }

        // 4. Perform the heavy cryptographic verification
        const verification = await verifyAuthenticationResponse({
            response: authenticationResponse,
            expectedChallenge: expectedChallenge,
            expectedOrigin: origin,
            expectedRPID: rpID,
            authenticator: {
                credentialPublicKey: Buffer.from(passkey.publicKey, 'base64'),
                credentialID: Buffer.from(passkey.credentialID, 'base64'),
                counter: passkey.counter,
            },
        });

        if (verification.verified) {
            // Update the authenticator's internal security counter
            passkey.counter = verification.authenticationInfo.newCounter;
            await user.save();
            
            // Consume and destroy the challenge so it can never be re-used (Replay Attack Prevention)
            loginChallengeStore.delete(expectedChallenge);

            // 5. Generate the standard JWT Session
            const sessionData = await generateSession(user, req);

            return res.status(200).json({ message: 'Passkey Verified', ...sessionData });
        }

        res.status(400).json({ message: 'Cryptographic verification failed.' });
    } catch (error) {
        console.error("[PASSKEY AUTH ERROR]:", error);
        res.status(500).json({ message: 'Failed to verify passkey authentication.' });
    }
};