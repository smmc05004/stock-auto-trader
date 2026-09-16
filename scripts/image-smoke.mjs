// Executed inside the exact image to be published, without network or broker keys.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { accessSync, constants, readFileSync, existsSync } from 'node:fs';
assert.equal(process.getuid(), 1000);
assert.match(process.env.APP_GIT_COMMIT, /^[a-f0-9]{40}$/);
accessSync('/app/range-runner.cjs', constants.R_OK);
assert.equal(existsSync('/app/deploy/paper.env'), false);
const db = new DatabaseSync('/app/data/smoke.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS probe (value TEXT); INSERT INTO probe VALUES (\'ok\')');
assert.equal(db.prepare('SELECT value FROM probe').get().value, 'ok');
db.close();
assert.ok(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
console.log('Image smoke passed: non-root, revision, bundle, writable SQLite, boot identity');
