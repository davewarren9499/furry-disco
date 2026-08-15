// One-time backfill: scan comments on every currently-open assigned IRIS
// ticket for an @mention, since the regular poller only ever checks
// "modified since last poll" and so never looks at existing history.
// Not wired into the app -- run manually with `node scripts/backfill-mentions.js`.
import 'dotenv/config';
import { db } from '../server/db.js';
import * as iris from '../server/integrations/iris.js';

const markMentioned = db.prepare(`
  UPDATE tasks SET meta = json_set(COALESCE(meta, '{}'), '$.mentionedInComments', 1)
  WHERE id = ?
`);

const rows = db.prepare("SELECT id, source_id, title FROM tasks WHERE source = 'iris' AND status = 'open'").all();
console.log(`Scanning ${rows.length} open tickets...`);

const CONCURRENCY = 8;
let flagged = 0;
let checked = 0;

async function worker(queue) {
  for (const row of queue) {
    try {
      const comments = await iris.fetchTicketComments(row.source_id);
      if (comments.some(iris.commentMentionsMe)) {
        markMentioned.run(row.id);
        flagged++;
        console.log(`  mentioned: ${row.title}`);
      }
    } catch (err) {
      console.error(`  failed on ${row.title}:`, err.message);
    }
    checked++;
    if (checked % 20 === 0) console.log(`...${checked}/${rows.length}`);
  }
}

const chunks = Array.from({ length: CONCURRENCY }, (_, i) => rows.filter((_, idx) => idx % CONCURRENCY === i));
await Promise.all(chunks.map(worker));

console.log(`Done. Flagged ${flagged} of ${rows.length} tickets.`);
