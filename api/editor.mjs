import { loadConfig } from '../server/config.mjs';
import { createDatabase } from '../server/db.mjs';
import { createHandler } from '../server/http.mjs';
import { createGitHubApp } from '../server/github.mjs';
const config = loadConfig();
const db = config.configured ? createDatabase(config) : null;
const publisher = config.github ? createGitHubApp(config.github) : null;
const handler = createHandler({ config, db, publisher });
// Vercel standalone Node fetch API preserves the original webhook bytes.
export default { fetch: handler };
