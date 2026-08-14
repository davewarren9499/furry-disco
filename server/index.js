import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { tasksRouter } from './routes/tasks.js';
import { commentsRouter } from './routes/comments.js';
import { templatesRouter } from './routes/templates.js';
import { missiveRouter } from './routes/missive.js';
import { pollAll } from './poller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const POLL_CRON = process.env.POLL_CRON || '*/2 * * * *'; // every 2 minutes by default

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/tasks', tasksRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/templates', templatesRouter);
app.use('/api/missive', missiveRouter);

app.post('/api/sync', async (req, res) => {
  const result = await pollAll();
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`furry-disco dashboard running at http://localhost:${PORT}`);
});

cron.schedule(POLL_CRON, () => {
  pollAll().then((r) => console.log('[poller] tick', r));
});

// Run one poll shortly after boot so the board isn't empty on first load.
setTimeout(() => {
  pollAll().then((r) => console.log('[poller] initial', r));
}, 3000);
