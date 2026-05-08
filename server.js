const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const buildRoutes = require('./routes/build');
const statusRoutes = require('./routes/status');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Ensure directories exist
['uploads', 'builds', 'logs'].forEach(dir => {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
});

// Serve built APKs
app.use('/builds', express.static(path.join(__dirname, 'builds')));

// Routes
app.use('/api/build', buildRoutes);
app.use('/api/status', statusRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString(),
    sdks: {
      java: process.env.JAVA_HOME ? 'configured' : 'not configured',
      android: process.env.ANDROID_HOME ? 'configured' : 'not configured',
      flutter: process.env.FLUTTER_HOME ? 'configured' : 'not configured',
      nodejs: process.version
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 APK Builder Backend running on port ${PORT}`);
});

module.exports = app;
