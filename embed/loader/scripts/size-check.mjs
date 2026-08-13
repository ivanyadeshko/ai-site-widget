import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 8 * 1024;
const dist = new URL('../dist/', import.meta.url).pathname;
const bundle = readdirSync(dist).find((f) => /^w\.[^.]+\.js$/.test(f));
const size = gzipSync(readFileSync(join(dist, bundle))).length;
console.log(`${bundle}: ${size} байт gzip (потолок ${LIMIT})`);
if (size > LIMIT) { console.error('БЮДЖЕТ ПРЕВЫШЕН — лоадер на чужой странице обязан быть крошечным'); process.exit(1); }
