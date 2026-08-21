require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');

// Route Imports
const authRoutes = require('./routes/auth');
const messageRoutes = require('./routes/messages');
const userRoutes = require('./routes/user');
const statusRoutes = require('./routes/status');
const roomRoutes = require('./routes/rooms');

// Socket & Cron Imports
const socketHandler = require('./sockets/socketHandler');
const startVoidScrubber = require('./cron/voidScrubber');

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);

// Cors Configuration
const allowedOrigins = [process.env.FRONTEND_URL, 'http://localhost:5173'];

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));

// Security Headers
app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                connectSrc: ["'self'", "https://api.cloudinary.com", "ws://localhost:5000", "wss:"],
                imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
            },
        },
    })
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));

// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Connected to MongoDB Atlas'))
    .catch((err) => console.error('MongoDB Connection Error:', err));

mongoose.connection.on('disconnected', () => {
    console.error('MongoDB disconnected! Connection lost.');
});

mongoose.connection.on('reconnected', () => {
    console.log('MongoDB reconnected successfully.');
});

// Mount Routes
app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/calls', require('./routes/calls'));

// Global Error Handling
app.use((err, req, res, next) => {
    console.error(`[Global Error]: ${err.message}`);
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
        success: false,
        error: statusCode === 500 ? 'Internal Server Error' : err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// Socket Initialization
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true
    }
});

socketHandler(io);

// Background Jobs
if (typeof startVoidScrubber === 'function') {
    startVoidScrubber();
}

app.get('/', (req, res) => {
    res.status(200).send('Server is up and running!');
});

// Start Listening
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});