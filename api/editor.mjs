import { loadConfig } from '../server/config.mjs';
import { createDatabase } from '../server/db.mjs';
import { createHandler } from '../server/http.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicationRegistry, publicationRegistryConfig } from '../server/publication-registry.mjs';
const loaded = loadConfig();
const config = { ...loaded, ...publicationRegistryConfig(loaded) };
const db = config.configured ? createDatabase(config) : null;
const publisher = createPublicationRegistry(db, config, { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
const handler = createHandler({ config, db, publisher });
// Vercel standalone Node fetch API preserves the original webhook bytes.
export default { fetch: handler };
