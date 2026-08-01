/**
 * Rebuild the web-sized image derivatives in assets/ from the full-resolution
 * originals in the repository root.
 *
 *   npm install          # installs sharp (dev dependency)
 *   npm run images
 *
 * The originals are camera files — DSC_8017.jpg alone is 13 MB at 5743px and was
 * being served as the dashboard background on every page load. Nothing in the
 * app should reference the originals directly; point CSS and <img> tags at the
 * assets/ derivatives this script produces.
 *
 * ---------------------------------------------------------------------------
 * Output format is decided by the CONTENT, never the file name.
 * ---------------------------------------------------------------------------
 * Several originals here are PNGs that happen to be named ".jpg" —
 * Name.jpg and Page-Header.jpg are transparent logos. Encoding those as JPEG
 * silently destroys the alpha channel and flattens it onto sharp's default
 * background, which is black. Because both logos are drawn with
 * `mix-blend-multiply`, the result was a solid black box where the logo should
 * be. So: if the source has an alpha channel, the derivative is a PNG.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = path.join(root, 'assets');

// `dest` deliberately carries no extension — it is chosen below.
const JOBS = [
  { src: 'DSC_8017.jpg',    dest: 'bg-dashboard', width: 1920, quality: 70 },
  { src: 'DSC_8010.jpg',    dest: 'bg-login',     width: 1600, quality: 72 },
  { src: 'Login Tab.jpg',   dest: 'login-card',   width: 760,  quality: 74 },
  { src: 'Name.jpg',        dest: 'name',         width: 640,  quality: 90 },
  { src: 'Page-Header.jpg', dest: 'page-header',  width: 1200, quality: 90 },
  { src: 'leaf-pattern.png', dest: 'leaf-pattern', width: 600, quality: 90 }
];

fs.mkdirSync(out, { recursive: true });

let savedBytes = 0;
const produced = [];

for (const job of JOBS) {
  const src = path.join(root, job.src);
  if (!fs.existsSync(src)) {
    console.warn(`skip   ${job.src} (not found)`);
    continue;
  }

  const meta = await sharp(src).metadata();
  const keepAlpha = !!meta.hasAlpha;
  const ext = keepAlpha ? 'png' : 'jpg';
  const destName = `${job.dest}.${ext}`;

  let pipeline = sharp(src)
    .rotate()                                       // honour EXIF orientation
    .resize({ width: job.width, withoutEnlargement: true });

  pipeline = keepAlpha
    // palette keeps transparent logos small without touching the alpha channel
    ? pipeline.png({ compressionLevel: 9, palette: true, quality: job.quality })
    : pipeline.jpeg({ quality: job.quality, progressive: true, mozjpeg: true });

  await pipeline.toFile(path.join(out, destName));

  const before = fs.statSync(src).size;
  const after = fs.statSync(path.join(out, destName)).size;
  savedBytes += before - after;
  produced.push(destName);

  const note = meta.format !== (job.src.split('.').pop().toLowerCase() === 'jpg' ? 'jpeg' : 'png')
    ? `  (source is really ${meta.format})` : '';

  console.log(
    `${destName.padEnd(20)} ${(before / 1048576).toFixed(2)} MB -> ${(after / 1024).toFixed(0)} KB` +
    `  ${keepAlpha ? 'PNG, alpha kept' : 'JPEG'}${note}`
  );
}

const icon = path.join(root, 'icon-192.png');
if (fs.existsSync(icon)) {
  await sharp(icon).resize(180, 180).png({ compressionLevel: 9 }).toFile(path.join(out, 'favicon.png'));
  console.log('favicon.png          rebuilt');
}

console.log(`\nSaved ${(savedBytes / 1048576).toFixed(1)} MB of page weight.`);
console.log('If a name changed, update the references in the HTML and in sw.js.');
