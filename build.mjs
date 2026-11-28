// Builds the static site: copies src/ into dist/ and fills each page's
// <!-- @head --> <!-- @header --> <!-- @team --> <!-- @footer --> markers
// from src/_partials, with links adjusted for how deep the page sits.
import { rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');
const partialsDir = join(src, '_partials');
const VERSION = '28'; // bump to make browsers fetch fresh CSS/JS

const partial = name => readFileSync(join(partialsDir, `${name}.html`), 'utf8');
const parts = { head: partial('head'), header: partial('header'), footer: partial('footer'), team: partial('team') };

const attrs = text => Object.fromEntries([...text.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

function renderPage(html, depth) {
  const rootPath = depth === 0 ? '' : '../'.repeat(depth);
  const base = { root: rootPath, v: VERSION };
  let out = html.replace(/<!--\s*@(header|head|footer|team)\b([^>]*?)-->/g, (m, name, rest) => {
    const a = attrs(rest);
    let piece = fill(parts[name], { ...base, ...a });
    if (name === 'header' && a.page) {
      piece = piece.replace(`data-page="${a.page}"`, `data-page="${a.page}" aria-current="page"`);
    }
    return piece;
  });
  out = fill(out, base);
  const left = out.match(/<!--\s*@\w+[^>]*|\{\{\w+\}\}/);
  if (left) throw new Error(`Unfilled marker left in page: ${left[0]}`);
  return out;
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const from = join(dir, name);
    if (from === partialsDir) continue;
    const rel = relative(src, from);
    const to = join(dist, rel);
    if (statSync(from).isDirectory()) { mkdirSync(to, { recursive: true }); walk(from); continue; }
    if (name.endsWith('.html')) {
      const depth = rel.split(sep).length - 1;
      writeFileSync(to, renderPage(readFileSync(from, 'utf8'), depth));
    } else {
      copyFileSync(from, to);
    }
  }
}

if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
walk(src);

// The dashboard talks to Supabase with the official client, copied in from node_modules.
const supabaseClient = join(root, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
if (!existsSync(supabaseClient)) { console.error('Build failed: run npm ci first (Supabase client missing)'); process.exit(1); }
mkdirSync(join(dist, 'dashboard', 'vendor'), { recursive: true });
copyFileSync(supabaseClient, join(dist, 'dashboard', 'vendor', 'supabase.js'));

const pages = [];
(function list(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) list(p); else if (n.endsWith('.html')) pages.push(relative(dist, p));
  }
})(dist);
if (!pages.includes('index.html')) { console.error('Build failed: index.html missing'); process.exit(1); }
console.log(`Built ${pages.length} pages: ${pages.join(', ')}`);
