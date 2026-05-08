// In-memory job store
// For production, replace with Redis or a database
const buildJobs = new Map();

// Clean up old jobs every hour
setInterval(() => {
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();
  buildJobs.forEach((job, id) => {
    if (now - new Date(job.createdAt).getTime() > ONE_HOUR * 24) {
      buildJobs.delete(id);
    }
  });
}, 60 * 60 * 1000);

module.exports = { buildJobs };
