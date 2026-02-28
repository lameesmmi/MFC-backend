'use strict';

require('dotenv').config();
const express = require('express');
const http    = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors   = require('cors');
const jwt    = require('jsonwebtoken');

// Import our custom modules
const initMqttListener = require('./services/mqttListener');
const SystemLog  = require('./models/SystemLog');
const apiRoutes    = require('./routes/api');
const authRoutes   = require('./routes/auth');
const usersRoutes  = require('./routes/users');
const pumpRoutes   = require('./routes/pump');
const exportRoutes = require('./routes/export');
const { checkDeviceOffline } = require('./services/alertService');
const { requireAuth, JWT_SECRET } = require('./middleware/auth');

const app    = express();
const server = http.createServer(app);

// 1. Configure Socket.io with CORS for your React frontend
const ALLOWED_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173';

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json());

// Make Socket.io instance accessible inside route handlers via req.app.get('io')
app.set('io', io);

// 2. MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/mfc_database';

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB Connected Successfully');
    // Start device offline detection — runs every 30 s after DB is ready
    setInterval(() => checkDeviceOffline(io, SystemLog), 30_000);
  })
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 3. Initialize MQTT Listener and expose client for route handlers
const mqttClient = initMqttListener(io, SystemLog);
app.set('mqttClient', mqttClient);

// 4. Auth routes — public (no auth middleware)
app.use('/api/auth', authRoutes);

// 5. Protected routes
// Note: pumpRoutes is mounted before the general /api handler so it
// takes precedence. It carries its own auth via requireRole.
app.use('/api/users',  requireAuth, usersRoutes);
app.use('/api/pump',   pumpRoutes);
app.use('/api/export', exportRoutes);
app.use('/api',        requireAuth, apiRoutes);

// 6. Socket.io JWT middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.id;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

// 7. Socket.io Connection Log
io.on('connection', (socket) => {
  console.log('🔌 New React Client Connected:', socket.id, '| user:', socket.userId);

  socket.on('disconnect', () => {
    console.log('🔌 Client Disconnected');
  });
});

// 8. Start the Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 MQTT Broker target: ${process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883'}`);
});
