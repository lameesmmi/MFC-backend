'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');

// Import our custom modules
const initMqttListener = require('./services/mqttListener');
const SystemLog = require('./models/SystemLog');
const apiRoutes = require('./routes/api');
const { checkDeviceOffline } = require('./services/alertService');

const app = express();
const server = http.createServer(app);

// 1. Configure Socket.io with CORS for your React frontend
const io = new Server(server, {
  cors: {
    origin: "*", // In production, replace with your React app's URL
    methods: ["GET", "POST"]
  }
});

app.use(cors());
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

// 3. Initialize MQTT Listener
// We pass 'io' so it can emit live data, and 'SystemLog' so it can save to DB
const mqttClient = initMqttListener(io, SystemLog);

// 4. API Routes
app.use('/api', apiRoutes);

// 5. Socket.io Connection Log
io.on('connection', (socket) => {
  console.log('🔌 New React Client Connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('🔌 Client Disconnected');
  });
});

// 6. Start the Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 MQTT Broker target: ${process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883'}`);
});