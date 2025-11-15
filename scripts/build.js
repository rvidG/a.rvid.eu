// ...existing code...
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public');
const SITE_BASE = 'https://a.rvid.eu'; // used in sitemap

async function mkdirp(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([:{};,>])\s*/g, '$1')
    .trim();
}

function minifyHtml(html) {
  html = html.replace(/<!--(?!\[if|\s*\[endif)[\s\S]*?-->/g, '');
  html = html.replace(/>\s+</g, '><');
  html = html.replace(/\s{2,}/g, ' ');
  return html.trim();
}

async function readFileIfExists(p) {
  try {
    return await fs.promises.readFile(p, 'utf8');
  } catch (e) {
    return null;
  }
}

async function resolveIncludes(content, baseDir, seen = new Set()) {
  const includeRegex = /<!--#include\s+virtual="([^"]+)"\s+-->/g;
  let match;
  let out = content;
  while ((match = includeRegex.exec(content)) !== null) {
    const includePathRaw = match[1];
    const includePath = includePathRaw.startsWith('/')
      ? path.join(ROOT, includePathRaw)
      : path.join(baseDir, includePathRaw);
    const realPath = path.normalize(includePath);
    if (seen.has(realPath)) {
      out = out.replace(match[0], `<!-- cyclic-include:${includePathRaw} -->`);
      continue;
    }
    seen.add(realPath);
    const incContent = await readFileIfExists(realPath);
    if (incContent == null) {
      out = out.replace(match[0], `<!-- missing-include:${includePathRaw} -->`);
    } else {
      const resolved = await resolveIncludes(incContent, path.dirname(realPath), seen);
      out = out.replace(match[0], resolved);
    }
    seen.delete(realPath);
  }
  return out;
}

async function walkDir(dir, extFilter = null) {
  const res = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'public') continue;
      res.push(...await walkDir(full, extFilter));
    } else {
      if (!extFilter || full.endsWith(extFilter)) res.push(full);
    }
  }
  return res;
}

async function copyFolder(src, dest, ignorePatterns = []) {
  await mkdirp(dest);
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ignorePatterns.some(p => s.includes(p))) continue;
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'public') continue;
      await copyFolder(s, d, ignorePatterns);
    } else {
      await mkdirp(path.dirname(d));
      await fs.promises.copyFile(s, d);
    }
  }
}

async function build() {
  await fs.promises.rm(OUT, { recursive: true, force: true }).catch(() => {});
  await mkdirp(OUT);

  const shtmlFiles = await walkDir(ROOT, '.shtml');
  for (const sfile of shtmlFiles) {
    if (sfile.includes(path.sep + 'public' + path.sep)) continue;
    const rel = path.relative(ROOT, sfile);
    const htmlRel = rel.replace(/\.shtml$/i, '.html');
    const target = path.join(OUT, htmlRel);
    const raw = await fs.promises.readFile(sfile, 'utf8');
    const resolved = await resolveIncludes(raw, path.dirname(sfile));
    const minified = minifyHtml(resolved);
    await mkdirp(path.dirname(target));
    await fs.promises.writeFile(target, minified, 'utf8');
    console.log('Wrote HTML:', path.relative(ROOT, target));
  }

  const staticSrc = path.join(ROOT, 'static');
  if (fs.existsSync(staticSrc)) {
    const cssFiles = await walkDir(staticSrc, '.css');
    for (const css of cssFiles) {
      const rel = path.relative(staticSrc, css);
      const cssText = await fs.promises.readFile(css, 'utf8');
      const min = minifyCss(cssText);
      const outPath = path.join(OUT, 'static', rel);
      await mkdirp(path.dirname(outPath));
      await fs.promises.writeFile(outPath, min, 'utf8');
      console.log('Wrote CSS:', path.relative(ROOT, outPath));
    }
    const staticEntries = await walkDir(staticSrc);
    for (const f of staticEntries) {
      if (f.endsWith('.css')) continue;
      const rel = path.relative(staticSrc, f);
      const outPath = path.join(OUT, 'static', rel);
      await mkdirp(path.dirname(outPath));
      await fs.promises.copyFile(f, outPath);
    }
  }

  const imagesSrc = path.join(ROOT, 'images');
  if (fs.existsSync(imagesSrc)) {
    await copyFolder(imagesSrc, path.join(OUT, 'images'));
  }

  const topAssets = ['favicon.svg', 'robots.txt', '404.html'];
  for (const a of topAssets) {
    const src = path.join(ROOT, a);
    if (fs.existsSync(src)) {
      const outPath = path.join(OUT, a);
      if (a === '404.html') {
        // Minify 404.html
        const html = await fs.promises.readFile(src, 'utf8');
        const minified = minifyHtml(html);
        await fs.promises.writeFile(outPath, minified, 'utf8');
      } else {
        await fs.promises.copyFile(src, outPath);
      }
    }
  }

  const htmlFiles = await walkDir(OUT, '.html');
  const now = new Date().toISOString();
  const urls = htmlFiles.map(f => {
    const rel = path.relative(OUT, f).replace(/\\/g, '/');
    const loc = `${SITE_BASE}/${rel.replace(/index\.html$/, '').replace(/\.html$/, '')}`.replace(/\/$/, '/');
    return `<url><loc>${loc}</loc><lastmod>${now}</lastmod></url>`;
  });
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  await fs.promises.writeFile(path.join(OUT, 'sitemap.xml'), sitemap, 'utf8');
  console.log('Wrote sitemap.xml');

  console.log('Build complete. Output in:', OUT);
}

if (require.main === module) {
  build().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { build };