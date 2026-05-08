const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { buildJobs } = require('../utils/jobStore');

// GET /api/status/:jobId
router.get('/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = buildJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    jobId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    framework: job.framework,
    logs: job.logs,
    apkUrl: job.apkUrl || null,
    apkSize: job.apkSize || null,
    createdAt: job.createdAt,
    completedAt: job.completedAt || null,
    error: job.error || null
  });
});

// GET /api/status/:jobId/stream — Server-Sent Events
router.get('/:jobId/stream', (req, res) => {
  const { jobId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const sendUpdate = () => {
    const job = buildJobs.get(jobId);
    if (!job) {
      res.write(`data: ${JSON.stringify({ error: 'Job not found' })}\n\n`);
      return clearInterval(interval);
    }

    res.write(`data: ${JSON.stringify({
      status: job.status,
      progress: job.progress,
      message: job.message,
      logs: job.logs,
      apkUrl: job.apkUrl || null,
      apkSize: job.apkSize || null
    })}\n\n`);

    if (['completed', 'failed'].includes(job.status)) {
      clearInterval(interval);
      res.end();
    }
  };

  const interval = setInterval(sendUpdate, 1000);
  sendUpdate(); // immediate first update

  req.on('close', () => clearInterval(interval));
});

// GET /api/status/:jobId/download — download the APK
router.get('/:jobId/download', (req, res) => {
  const { jobId } = req.params;
  const job = buildJobs.get(jobId);

  if (!job || job.status !== 'completed' || !job.apkPath) {
    return res.status(404).json({ error: 'APK not ready or job not found' });
  }

  if (!fs.existsSync(job.apkPath)) {
    return res.status(404).json({ error: 'APK file not found on disk' });
  }

  const filename = `${job.config.appName.replace(/\s+/g, '_')}_v${job.config.versionName}.apk`;
  res.download(job.apkPath, filename);
});

// GET /api/status/list — list all jobs (admin)
router.get('/', (req, res) => {
  const jobs = [];
  buildJobs.forEach((job, id) => {
    jobs.push({
      jobId: id,
      status: job.status,
      framework: job.framework,
      appName: job.config?.appName,
      createdAt: job.createdAt,
      progress: job.progress
    });
  });
  res.json({ jobs: jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

module.exports = router;
