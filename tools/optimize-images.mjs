/**
 * Rebuild the web-sized image derivatives in assets/ from the full-resolution
 * originals in the repository root.
 *
 *   npm install          # installs sharp (dev dependency)
 *   node tools/optimize-images.mjs
 *
 * The originals are camera files — DSC_8017.jpg alone is 13 MB at 5743px and was
 * being served as the dashboard background on every page load. Nothing in the
 * app should ever reference the originals directly; point CSS and <img> tags at
 * the assets/ derivatives this script produces.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = path.join(root, 'assets');

const JOBS = [
  { src: 'DSC_8017.jpg',   dest: 'bg-dashboard.jpg', width: 1920, quality: 70 },
  { src: 'DSC_8010.jpg',   dest: 'bg-login.jpg',     width: 1600, quality: 72 },
  { src: 'Login Tab.jpg',  dest: 'login-card.jpg',   width: 760,  quality: 74 },
  { src: 'Name.jpg',       dest: 'name.jpg',         width: 640,  quality: 80 },
  { src: 'Page-Header.jpg', dest: 'page-header.jpg', width: 1200, quality: 82 }
];

fs.mkdirSync(out, { recursive: true });

let savedBytes = 0;

for (const job of JOBS) {
  const src = path.join(root, job.src);
  if (!fs.existsSync(src)) {
    console.warn(`skip   ${job.src} (not found)`);
    continue;
  }
  const before = fs.statSync(src).size;
  await sharp(src)
    .rotate()                                        // honour EXIF orientation
    .resize({ width: job.width, withoutEnlargement: true })
    .jpeg({ quality: job.quality, progressive: true, mozjpeg: true })
    .toFile(path.join(out, job.dest));
  const after = fs.statSync(path.join(out, job.dest)).size;
  savedBytes += before - after;
  console.log(
    `${job.dest.padEnd(20)} ${(before / 1048576).toFixed(2)} MB -> ${(after / 1024).toFixed(0)} KB` +
    `  (${(before / after).toFixed(0)}x smaller)`
  );
}

// Watermark used by the workbench panel.
const leaf = path.join(root, 'leaf-pattern.png');
if (fs.existsSync(leaf)) {
  await sharp(leaf).resize({ width: 600, withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true }).toFile(path.join(out, 'leaf-pattern.png'));
  console.log('leaf-pattern.png     rebuilt');
}

const icon = path.join(root, 'icon-192.png');
if (fs.existsSync(icon)) {
  await sharp(icon).resize(180, 180).png({ compressionLevel: 9 }).toFile(path.join(out, 'favicon.png'));
  console.log('favicon.png          rebuilt');
}

console.log(`\nSaved ${(savedBytes / 1048576).toFixed(1)} MB of page weight.`);
