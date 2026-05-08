const cloudinary = require('cloudinary').v2;
const multer = require('multer');

// Configure Cloudinary with your environment variables
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Use Native Memory Storage to securely hold the file before streaming
const storage = multer.memoryStorage();

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB safety limit
});

module.exports = { cloudinary, upload };