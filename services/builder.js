const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { buildJobs } = require('../utils/jobStore');

// Update job progress helper
const updateJob = (jobId, updates) => {
  const job = buildJobs.get(jobId);
  if (job) {
    Object.assign(job, updates);
    buildJobs.set(jobId, job);
  }
};

const log = (jobId, message) => {
  const job = buildJobs.get(jobId);
  if (job) {
    job.logs.push(`[${new Date().toISOString()}] ${message}`);
    buildJobs.set(jobId, job);
    console.log(`[${jobId}] ${message}`);
  }
};

// Run shell command with logging
const runCommand = (jobId, command, cwd, progressStart, progressEnd) => {
  return new Promise((resolve, reject) => {
    log(jobId, `$ ${command}`);
    const proc = spawn('bash', ['-c', command], { cwd, env: { ...process.env } });
    
    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      text.split('\n').filter(Boolean).forEach(line => log(jobId, line));
      
      // Estimate progress
      const job = buildJobs.get(jobId);
      if (job && job.progress < progressEnd) {
        updateJob(jobId, { progress: Math.min(job.progress + 1, progressEnd) });
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      text.split('\n').filter(Boolean).forEach(line => log(jobId, `⚠ ${line}`));
    });

    proc.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Command failed (exit ${code}): ${errorOutput || output}`));
    });
  });
};

// ─── Framework Detection ───────────────────────────────────────────────────
const detectFramework = async (uploadDir, files) => {
  if (!files?.sourceZip?.[0]) return 'android-native';
  
  const zipPath = files.sourceZip[0].path;
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().map(e => e.entryName);
    
    if (entries.some(e => e.includes('pubspec.yaml'))) return 'flutter';
    if (entries.some(e => e.includes('app.json') || e.includes('app.config.js'))) return 'expo';
    if (entries.some(e => e.includes('ionic.config.json'))) return 'ionic';
    if (entries.some(e => e.includes('capacitor.config.json'))) return 'capacitor';
    if (entries.some(e => e.includes('config.xml'))) return 'cordova';
    if (entries.some(e => e.includes('nativescript.config'))) return 'nativescript';
    if (entries.some(e => e.includes('manifest.json') && !e.includes('node_modules'))) return 'pwa-twa';
    if (entries.some(e => e.includes('package.json'))) {
      const pkgEntry = zip.getEntry(entries.find(e => e.endsWith('package.json') && !e.includes('node_modules')));
      if (pkgEntry) {
        const pkg = JSON.parse(pkgEntry.getData().toString());
        if (pkg.dependencies?.['react-native'] || pkg.dependencies?.expo) return 'react-native';
      }
      return 'cordova'; // fallback for web-based
    }
    if (entries.some(e => e.includes('build.gradle'))) {
      const hasKotlin = entries.some(e => e.endsWith('.kt'));
      return hasKotlin ? 'android-native' : 'android-native';
    }
  } catch (e) {
    console.error('Framework detection error:', e);
  }
  
  return 'android-native';
};

// ─── Extract ZIP ───────────────────────────────────────────────────────────
const extractSource = (jobId, zipPath, targetDir) => {
  log(jobId, `Extracting source files...`);
  fs.mkdirSync(targetDir, { recursive: true });
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(targetDir, true);
  log(jobId, `✅ Extraction complete`);
};

// ─── Copy Assets ───────────────────────────────────────────────────────────
const copyAssets = (jobId, job, projectDir) => {
  const { files } = job;
  
  const assetDirs = {
    icons: path.join(projectDir, '_assets/icons'),
    assets: path.join(projectDir, '_assets/files'),
    splashScreens: path.join(projectDir, '_assets/splash')
  };

  Object.entries(assetDirs).forEach(([key, dir]) => {
    const filePaths = files[key];
    if (filePaths?.length) {
      fs.mkdirSync(dir, { recursive: true });
      filePaths.forEach(fp => {
        fs.copyFileSync(fp, path.join(dir, path.basename(fp)));
      });
      log(jobId, `✅ Copied ${filePaths.length} ${key}`);
    }
  });
};

// ─── Builders per Framework ────────────────────────────────────────────────

const builders = {
  
  'flutter': async (jobId, job, projectDir) => {
    log(jobId, '🐦 Building Flutter APK...');
    updateJob(jobId, { progress: 20, message: 'Installing Flutter dependencies...' });
    await runCommand(jobId, 'flutter pub get', projectDir, 20, 40);
    updateJob(jobId, { progress: 40, message: 'Building APK...' });
    const buildCmd = job.config.buildType === 'release' 
      ? 'flutter build apk --release' 
      : 'flutter build apk --debug';
    await runCommand(jobId, buildCmd, projectDir, 40, 90);
    const apkPath = path.join(projectDir, `build/app/outputs/flutter-apk/app-${job.config.buildType}.apk`);
    return apkPath;
  },

  'react-native': async (jobId, job, projectDir) => {
    log(jobId, '⚛️ Building React Native APK...');
    updateJob(jobId, { progress: 15, message: 'Installing npm dependencies...' });
    await runCommand(jobId, 'npm install --legacy-peer-deps', projectDir, 15, 35);
    updateJob(jobId, { progress: 35, message: 'Building Android APK...' });
    const gradleCmd = job.config.buildType === 'release'
      ? './gradlew assembleRelease'
      : './gradlew assembleDebug';
    await runCommand(jobId, gradleCmd, path.join(projectDir, 'android'), 35, 90);
    const apkDir = path.join(projectDir, `android/app/build/outputs/apk/${job.config.buildType}`);
    const apkName = `app-${job.config.buildType}.apk`;
    return path.join(apkDir, apkName);
  },

  'expo': async (jobId, job, projectDir) => {
    log(jobId, '🌌 Building Expo APK...');
    updateJob(jobId, { progress: 15, message: 'Installing dependencies...' });
    await runCommand(jobId, 'npm install', projectDir, 15, 30);
    updateJob(jobId, { progress: 30, message: 'Running expo prebuild...' });
    await runCommand(jobId, 'npx expo prebuild --platform android', projectDir, 30, 50);
    updateJob(jobId, { progress: 50, message: 'Building APK with Gradle...' });
    const gradleCmd = job.config.buildType === 'release'
      ? './gradlew assembleRelease'
      : './gradlew assembleDebug';
    await runCommand(jobId, gradleCmd, path.join(projectDir, 'android'), 50, 90);
    const apkDir = path.join(projectDir, `android/app/build/outputs/apk/${job.config.buildType}`);
    return path.join(apkDir, `app-${job.config.buildType}.apk`);
  },

  'cordova': async (jobId, job, projectDir) => {
    log(jobId, '📱 Building Cordova APK...');
    updateJob(jobId, { progress: 15, message: 'Installing Cordova dependencies...' });
    await runCommand(jobId, 'npm install -g cordova && npm install', projectDir, 15, 30);
    updateJob(jobId, { progress: 30, message: 'Adding Android platform...' });
    await runCommand(jobId, 'cordova platform add android', projectDir, 30, 50);
    updateJob(jobId, { progress: 50, message: 'Building APK...' });
    const buildCmd = job.config.buildType === 'release'
      ? 'cordova build android --release'
      : 'cordova build android --debug';
    await runCommand(jobId, buildCmd, projectDir, 50, 90);
    return path.join(projectDir, 'platforms/android/app/build/outputs/apk', job.config.buildType, `app-${job.config.buildType}.apk`);
  },

  'ionic': async (jobId, job, projectDir) => {
    log(jobId, '⚡ Building Ionic APK...');
    updateJob(jobId, { progress: 15, message: 'Installing dependencies...' });
    await runCommand(jobId, 'npm install -g @ionic/cli && npm install', projectDir, 15, 30);
    updateJob(jobId, { progress: 30, message: 'Building Ionic...' });
    await runCommand(jobId, 'ionic build --prod', projectDir, 30, 50);
    await runCommand(jobId, 'ionic capacitor add android || ionic cordova platform add android', projectDir, 50, 60);
    updateJob(jobId, { progress: 60, message: 'Building APK...' });
    await runCommand(jobId, './gradlew assembleDebug', path.join(projectDir, 'android'), 60, 90);
    return path.join(projectDir, 'android/app/build/outputs/apk/debug/app-debug.apk');
  },

  'capacitor': async (jobId, job, projectDir) => {
    log(jobId, '🔋 Building Capacitor APK...');
    updateJob(jobId, { progress: 15, message: 'Installing dependencies...' });
    await runCommand(jobId, 'npm install', projectDir, 15, 30);
    await runCommand(jobId, 'npm run build', projectDir, 30, 45);
    await runCommand(jobId, 'npx cap add android || true', projectDir, 45, 50);
    await runCommand(jobId, 'npx cap sync android', projectDir, 50, 60);
    updateJob(jobId, { progress: 60, message: 'Building APK...' });
    await runCommand(jobId, './gradlew assembleDebug', path.join(projectDir, 'android'), 60, 90);
    return path.join(projectDir, 'android/app/build/outputs/apk/debug/app-debug.apk');
  },

  'nativescript': async (jobId, job, projectDir) => {
    log(jobId, '🔷 Building NativeScript APK...');
    updateJob(jobId, { progress: 15, message: 'Installing dependencies...' });
    await runCommand(jobId, 'npm install -g nativescript && npm install', projectDir, 15, 35);
    updateJob(jobId, { progress: 35, message: 'Building APK...' });
    await runCommand(jobId, 'ns build android --for-device', projectDir, 35, 90);
    return path.join(projectDir, 'platforms/android/app/build/outputs/apk/debug/app-debug.apk');
  },

  'android-native': async (jobId, job, projectDir) => {
    log(jobId, '🤖 Building Android Native APK...');
    // Patch app name and package name
    const manifestPath = path.join(projectDir, 'app/src/main/AndroidManifest.xml');
    if (fs.existsSync(manifestPath)) {
      let manifest = fs.readFileSync(manifestPath, 'utf8');
      manifest = manifest.replace(/package="[^"]*"/, `package="${job.config.packageName}"`);
      fs.writeFileSync(manifestPath, manifest);
    }
    updateJob(jobId, { progress: 30, message: 'Running Gradle build...' });
    const gradleCmd = job.config.buildType === 'release'
      ? './gradlew assembleRelease'
      : './gradlew assembleDebug';
    await runCommand(jobId, 'chmod +x ./gradlew && ' + gradleCmd, projectDir, 30, 90);
    return path.join(projectDir, `app/build/outputs/apk/${job.config.buildType}/app-${job.config.buildType}.apk`);
  },

  'pwa-twa': async (jobId, job, projectDir) => {
    log(jobId, '🌐 Building PWA → APK via Bubblewrap...');
    updateJob(jobId, { progress: 15, message: 'Setting up Bubblewrap...' });
    await runCommand(jobId, 'npm install -g @bubblewrap/cli', projectDir, 15, 25);
    const manifestPath = path.join(projectDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const twaUrl = manifest.start_url || manifest.scope || 'https://example.com';
    updateJob(jobId, { progress: 25, message: 'Initializing TWA project...' });
    await runCommand(jobId, `bubblewrap init --manifest="${twaUrl}/manifest.json"`, projectDir, 25, 50);
    updateJob(jobId, { progress: 50, message: 'Building APK...' });
    await runCommand(jobId, 'bubblewrap build', projectDir, 50, 90);
    return path.join(projectDir, 'app-release-unsigned.apk');
  }
};

// ─── Main Build Orchestrator ───────────────────────────────────────────────
const buildAPK = async (jobId, job) => {
  const workDir = path.join(__dirname, '../builds', jobId);
  const projectDir = path.join(workDir, 'project');
  const outputDir = path.join(__dirname, '../builds');

  try {
    updateJob(jobId, { status: 'building', progress: 5, message: 'Preparing build environment...' });
    fs.mkdirSync(workDir, { recursive: true });

    // Extract source
    if (job.files.sourceZip) {
      updateJob(jobId, { progress: 10, message: 'Extracting source files...' });
      extractSource(jobId, job.files.sourceZip, projectDir);
    }

    // Copy user assets
    if (job.files.assets?.length || job.files.icons?.length || job.files.splashScreens?.length) {
      updateJob(jobId, { progress: 12, message: 'Copying assets...' });
      copyAssets(jobId, job, projectDir);
    }

    // Get builder for framework
    const builder = builders[job.framework] || builders['android-native'];
    updateJob(jobId, { progress: 15, message: `Starting ${job.framework} build...` });

    const apkPath = await builder(jobId, job, projectDir);

    // Verify APK exists
    if (!fs.existsSync(apkPath)) {
      throw new Error(`APK not found at expected path: ${apkPath}`);
    }

    // Copy to output
    const finalApkName = `${jobId}_${job.config.appName.replace(/\s+/g, '_')}_v${job.config.versionName}.apk`;
    const finalApkPath = path.join(outputDir, finalApkName);
    fs.copyFileSync(apkPath, finalApkPath);

    const stats = fs.statSync(finalApkPath);
    const apkSizeMB = (stats.size / 1024 / 1024).toFixed(2);

    updateJob(jobId, {
      status: 'completed',
      progress: 100,
      message: `✅ Build complete! APK size: ${apkSizeMB} MB`,
      apkPath: finalApkPath,
      apkUrl: `/builds/${finalApkName}`,
      apkSize: `${apkSizeMB} MB`,
      completedAt: new Date().toISOString()
    });

    log(jobId, `🎉 APK ready: ${finalApkName} (${apkSizeMB} MB)`);

  } catch (err) {
    log(jobId, `❌ Build failed: ${err.message}`);
    updateJob(jobId, {
      status: 'failed',
      progress: 0,
      message: `Build failed: ${err.message}`,
      error: err.message,
      completedAt: new Date().toISOString()
    });
    throw err;
  }
};

module.exports = { buildAPK, detectFramework };
