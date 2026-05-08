const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const { detectFramework, buildAPK } = require('../services/builder');
const { buildJobs } = require('../utils/jobStore');

// Multer config — accept zip, images, source files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const jobId = req.jobId;
    const uploadDir = path.join(__dirname, '../uploads', jobId);
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      '.zip', '.tar', '.gz', '.rar',
      '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico',
      '.json', '.xml', '.gradle', '.js', '.ts', '.dart',
      '.java', '.kt', '.html', '.css', '.env'
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext) || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${ext}`));
    }
  }
});

// Middleware to assign jobId before multer processes files
const assignJobId = (req, res, next) => {
  req.jobId = uuidv4();
  next();
};

// POST /api/build/submit
router.post('/submit', assignJobId, upload.fields([
  { name: 'sourceZip', maxCount: 1 },
  { name: 'assets', maxCount: 50 },
  { name: 'icons', maxCount: 10 },
  { name: 'splashScreens', maxCount: 5 },
  { name: 'keystore', maxCount: 1 }
]), async (req, res) => {
  try {
    const jobId = req.jobId;
    const { 
      framework, 
      appName, 
      packageName, 
      versionName, 
      versionCode,
      buildType,
      minSdk,
      targetSdk,
      permissions
    } = req.body;

    // Validate required fields
    if (!req.files?.sourceZip && !req.body.sourceCode) {
      return res.status(400).json({ error: 'Source code is required (zip file or inline code)' });
    }
    if (!appName) return res.status(400).json({ error: 'App name is required' });
    if (!packageName) return res.status(400).json({ error: 'Package name is required (e.g. com.myapp.name)' });

    // Auto-detect framework if not specified
    const uploadDir = path.join(__dirname, '../uploads', jobId);
    const detectedFramework = framework || await detectFramework(uploadDir, req.files);

    // Create job
    const job = {
      id: jobId,
      status: 'queued',
      progress: 0,
      message: 'Build queued...',
      framework: detectedFramework,
      config: {
        appName,
        packageName,
        versionName: versionName || '1.0.0',
        versionCode: parseInt(versionCode) || 1,
        buildType: buildType || 'debug',
        minSdk: parseInt(minSdk) || 21,
        targetSdk: parseInt(targetSdk) || 33,
        permissions: permissions ? JSON.parse(permissions) : []
      },
      files: {
        sourceZip: req.files?.sourceZip?.[0]?.path,
        assets: req.files?.assets?.map(f => f.path) || [],
        icons: req.files?.icons?.map(f => f.path) || [],
        splashScreens: req.files?.splashScreens?.map(f => f.path) || [],
        keystore: req.files?.keystore?.[0]?.path
      },
      createdAt: new Date().toISOString(),
      logs: []
    };

    buildJobs.set(jobId, job);

    // Start build async
    buildAPK(jobId, job).catch(err => {
      const j = buildJobs.get(jobId);
      if (j) {
        j.status = 'failed';
        j.message = err.message;
        j.logs.push(`[ERROR] ${err.message}`);
        buildJobs.set(jobId, j);
      }
    });

    res.json({
      success: true,
      jobId,
      message: `Build started for ${appName} (${detectedFramework})`,
      statusUrl: `/api/status/${jobId}`
    });

  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/build/frameworks
router.get('/frameworks', (req, res) => {
  res.json({
    frameworks: [
      { id: 'react-native', name: 'React Native', icon: '⚛️', extensions: ['.js', '.jsx', '.ts', '.tsx'], requires: ['package.json'] },
      { id: 'flutter', name: 'Flutter', icon: '🐦', extensions: ['.dart'], requires: ['pubspec.yaml'] },
      { id: 'cordova', name: 'Cordova / PhoneGap', icon: '📱', extensions: ['.html', '.js', '.css'], requires: ['config.xml'] },
      { id: 'ionic', name: 'Ionic', icon: '⚡', extensions: ['.ts', '.html'], requires: ['ionic.config.json'] },
      { id: 'capacitor', name: 'Capacitor', icon: '🔋', extensions: ['.ts', '.js'], requires: ['capacitor.config.json'] },
      { id: 'expo', name: 'Expo', icon: '🌌', extensions: ['.js', '.ts'], requires: ['app.json', 'app.config.js'] },
      { id: 'nativescript', name: 'NativeScript', icon: '🔷', extensions: ['.js', '.ts'], requires: ['nativescript.config.ts'] },
      { id: 'android-native', name: 'Android Native (Java/Kotlin)', icon: '🤖', extensions: ['.java', '.kt'], requires: ['build.gradle'] },
      { id: 'pwa-twa', name: 'PWA → APK (TWA/Bubblewrap)', icon: '🌐', extensions: ['.json'], requires: ['manifest.json'] },
      { id: 'unity', name: 'Unity (Android Export)', icon: '🎮', extensions: [], requires: ['ProjectSettings'] },
      { id: 'auto', name: 'Auto-detect', icon: '🔍', extensions: [], requires: [] }
    ]
  });
});

module.exports = router;
