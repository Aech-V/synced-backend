const express = require('express');
const { 
    registerUser, 
    loginUser,
    generateWebAuthnRegistration,
    verifyWebAuthnRegistration,
    verify2FALogin,
    requestPhoneOTP,
    requestMagicLink,
    registerLimiter,
    loginLimiter
} = require('../controllers/authController');

const router = express.Router();

// Core authentication
router.post('/register', registerLimiter, registerUser);
router.post('/login', loginLimiter, loginUser);

// WebAuthn passkey integration
router.get('/webauthn/generate-registration', generateWebAuthnRegistration);
router.post('/webauthn/verify-registration', verifyWebAuthnRegistration);

// Frictionless and 2FA authentication
router.post('/login/2fa', verify2FALogin);
router.post('/magic-link', requestMagicLink);
router.post('/otp/request', requestPhoneOTP);

module.exports = router;