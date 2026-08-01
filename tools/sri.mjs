/**
 * Regenerate Subresource Integrity hashes for the pinned CDN scripts.
 *
 *   node tools/sri.mjs            # print integrity="..." for each URL
 *   node tools/sri.mjs --check    # verify the hashes in the HTML still match
 *
 * Run this after bumping any pinned version, then paste the printed integrity
 * attribute into index.html / owner.html / staff.html. A wrong or stale hash
 * means the browser refuses to run the script — the page will look broken, so
 * always --check before deploying a version bump.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const URLS = [
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.23.6/babel.min.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-functions-compat.js'
];

const PAGES = ['index.html', 'owner.html', 'staff.html'];

async function hashOf(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  return 'sha384-' + crypto.createHash('sha384').update(body).digest('base64');
}

const check = process.argv.includes('--check');
let problems = 0;

for (const url of URLS) {
  let hash;
  try {
    hash = await hashOf(url);
  } catch (err) {
    console.error(`ERROR  ${url}\n       ${err.message}`);
    problems++;
    continue;
  }

  if (!check) {
    console.log(`${url}\n  integrity="${hash}"\n`);
    continue;
  }

  for (const page of PAGES) {
    const file = path.join(root, page);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    if (!html.includes(url)) continue;

    // Find the integrity attribute belonging to this script tag.
    const tag = html.slice(html.indexOf(url));
    const found = /integrity="([^"]+)"/.exec(tag.slice(0, 400));
    if (!found) {
      console.log(`MISSING  ${page}: ${url} has no integrity attribute`);
      problems++;
    } else if (found[1] !== hash) {
      console.log(`STALE    ${page}: ${url}\n         want ${hash}\n         have ${found[1]}`);
      problems++;
    } else {
      console.log(`ok       ${page}: ${path.basename(url)}`);
    }
  }
}

if (check) {
  console.log(problems === 0 ? '\nAll integrity hashes match.' : `\n${problems} problem(s) found.`);
}
process.exit(problems === 0 ? 0 : 1);
