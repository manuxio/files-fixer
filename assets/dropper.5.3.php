<?php
/**
 * JCE remediation dropper — PHP 5.3 EDITION (runs 5.3 through 8.3).
 *
 * Functional twin of src/dropper.php (the modern PHP 7.1+ reference). This is the artifact the
 * orchestrator actually deploys, because ~90% of the target fleet still runs PHP 5.3 and the
 * orchestrator does not know a site's PHP version until the probe executes — so the deployed file
 * must run on every version from 5.3 up.
 *
 * Modes: preflight | scan | verify | report (read-only), install | uninstall | enforce (mutating).
 * Placed in a Joomla docroot by the orchestrator (filesystem) and triggered over HTTP. Read-only
 * modes talk to the DB directly through a runtime-selected driver (mysqli, then legacy mysql, then
 * PDO) — never a fixed extension, because a 5.3 host may only ship ext/mysql while 7+ removed it.
 * install/uninstall bootstrap Joomla and use its own DBO, so they need no direct driver.
 *
 * Output is always JSON. On a bad/absent token it 403s with no side effects.
 *
 * PHP 5.3 rules honoured throughout: array() literals only, no scalar type hints / return types /
 * nullable types, no ?? / <=> / ::class, catch(Exception), array()-const via helper, JSON flags
 * gated with defined(), and polyfills for str_contains/str_starts_with/hash_equals/random_bytes/
 * http_response_code.
 */

/* ------------------------------------------------------------- configuration */

define('SCANNER_TOKEN',   '__SCANNER_TOKEN__');    // orchestrator replaces with a per-run secret
define('SCANNER_EXPIRES', '__SCANNER_EXPIRES__');  // epoch seconds; non-numeric => no expiry (dev)
define('TOOL_VERSION',    '0.1-readonly');
define('TARGET_JCE',      '2.9.99.8');             // version we upgrade to
define('FIRST_FIXED_JCE', '2.9.99.5');             // CVE-2026-48907 fixed here
define('PATCH_ELEMENT',   'patch_jce_27x_29x');    // legacy security-patch 'file' extension (PHP < 7.4 sites)
define('QUARANTINE_DIR',  'jce-quarantine');       // excluded from scans (created by enforce phase)
define('MAX_FILES',       60000);                  // recursion guard; truncation is reported, never silent
define('PHP_EXT_RE',      '/\.(php|php[0-9]|phtml|phar|pht|phps)$/i');
define('DBL_EXT_RE',      '/\.[a-z0-9]{1,12}\.(php|php[0-9]|phtml|phar|pht)$/i');

/* ---------------------------------------------------------------- bootstrap */

ini_set('display_errors', '0');
error_reporting(E_ALL);
header('Content-Type: application/json; charset=utf-8');
header('X-Robots-Tag: noindex, nofollow');

// Polyfills so this file runs on the OLD PHP of legacy sites (it executes on the target's PHP).
if (!function_exists('str_contains')) {
    function str_contains($haystack, $needle) { return $needle === '' || strpos($haystack, $needle) !== false; }
}
if (!function_exists('str_starts_with')) {
    function str_starts_with($haystack, $needle) { return strncmp($haystack, $needle, strlen($needle)) === 0; }
}
if (!function_exists('hash_equals')) {
    // constant-time compare (PHP 5.6+ ships one; provide it for 5.3/5.4/5.5)
    function hash_equals($known, $user) {
        if (!is_string($known) || !is_string($user)) { return false; }
        $lenK = strlen($known);
        if ($lenK !== strlen($user)) { return false; }
        $res = 0;
        for ($i = 0; $i < $lenK; $i++) { $res |= ord($known[$i]) ^ ord($user[$i]); }
        return $res === 0;
    }
}
if (!function_exists('random_bytes')) {
    // NOT cryptographic here: only used for throwaway quarantine filename nonces.
    function random_bytes($len) {
        if (function_exists('openssl_random_pseudo_bytes')) {
            $b = openssl_random_pseudo_bytes($len);
            if ($b !== false) { return $b; }
        }
        $s = '';
        for ($i = 0; $i < $len; $i++) { $s .= chr(mt_rand(0, 255)); }
        return $s;
    }
}
if (!function_exists('http_response_code')) {
    // PHP 5.4+ ships this; emit a status line by hand on 5.3.
    function http_response_code($code = null) {
        static $cur = 200;
        if ($code !== null) {
            $texts = array(200 => 'OK', 403 => 'Forbidden', 404 => 'Not Found', 500 => 'Internal Server Error');
            $proto = isset($_SERVER['SERVER_PROTOCOL']) ? $_SERVER['SERVER_PROTOCOL'] : 'HTTP/1.1';
            $txt = isset($texts[$code]) ? $texts[$code] : '';
            header($proto . ' ' . $code . ' ' . $txt, true, $code);
            $cur = $code;
        }
        return $cur;
    }
}

// JSON flags are 5.4+; degrade to 0 on 5.3 (compact JSON is still valid JSON).
$JSON_FLAGS = (defined('JSON_PRETTY_PRINT') ? JSON_PRETTY_PRINT : 0)
            | (defined('JSON_UNESCAPED_SLASHES') ? JSON_UNESCAPED_SLASHES : 0)
            | (defined('JSON_UNESCAPED_UNICODE') ? JSON_UNESCAPED_UNICODE : 0);

function deny($msg, $code = 403) {
    http_response_code($code);
    echo json_encode(array('error' => $msg), defined('JSON_UNESCAPED_SLASHES') ? JSON_UNESCAPED_SLASHES : 0);
    exit;
}

// Refuse to run an untemplated dropper (safety: prevents a stray copy from doing anything).
// Guard by pattern, not by an identical literal — a global template substitution would
// otherwise rewrite this sentinel too. Real per-run tokens are alnum and never start with "__".
if (SCANNER_TOKEN === '' || str_starts_with(SCANNER_TOKEN, '__')) {
    deny('dropper not templated (no token configured)');
}
$exp = is_numeric(SCANNER_EXPIRES) ? (int) SCANNER_EXPIRES : 0;
if ($exp > 0 && time() > $exp) {
    deny('dropper expired');
}
$given = (string) (isset($_REQUEST['token']) ? $_REQUEST['token'] : '');
if (!hash_equals(SCANNER_TOKEN, $given)) {
    deny('forbidden');
}

$mode       = preg_replace('/[^a-z]/', '', (string) (isset($_REQUEST['mode']) ? $_REQUEST['mode'] : 'report'));
$windowDays = (int) (isset($_REQUEST['window_days']) ? $_REQUEST['window_days'] : 15);
if ($windowDays < 1 || $windowDays > 3650) { $windowDays = 15; }
$runId      = preg_replace('/[^A-Za-z0-9_.:-]/', '', (string) (isset($_REQUEST['run_id']) ? $_REQUEST['run_id'] : ('r' . time())));
$docroot    = __DIR__;
$self       = basename(__FILE__);

// Mutating modes must finish (and clean up their extract dirs) even if the orchestrator's HTTP
// client times out first — a fresh full install can exceed the client timeout on slow hosts.
if (in_array($mode, array('install', 'uninstall', 'enforce'), true)) {
    @ignore_user_abort(true);
    @set_time_limit(600);
}

$report = array(
    'tool'         => 'jce-remediate-dropper',
    'tool_version' => TOOL_VERSION,
    'run_id'       => $runId,
    'mode'         => $mode,
    'utc'          => gmdate('c'),
    'docroot'      => $docroot,
    'php_version'  => PHP_VERSION,
    'env'          => probe_env(),
    'errors'       => array(),
);

/* ------------------------------------------------------------- config + DB */

$cfg = null;
try {
    $cfgFile = $docroot . '/configuration.php';
    if ($mode !== 'install' && is_file($cfgFile)) {
        if (!defined('_JEXEC')) { define('_JEXEC', 1); }
        require $cfgFile;                       // defines class JConfig
        if (class_exists('JConfig')) { $cfg = new JConfig(); }
    }
    // NB: install mode does NOT load config here — it bootstraps Joomla (which defines JConfig
    // itself); pre-including configuration.php would cause a "cannot redeclare JConfig" fatal.
} catch (Exception $e) {
    $report['errors'][] = 'config load: ' . $e->getMessage();
}

// Degrade (don't crash) if the host ships no usable MySQL driver at all.
if ($cfg !== null && $mode !== 'install' && ro_db_driver() === null) {
    $report['errors'][] = 'no MySQL driver available (mysqli/mysql/pdo_mysql) — DB checks skipped';
}

/* ------------------------------------------------------------------ phases */

try {
    if (in_array($mode, array('preflight', 'report'), true)) {
        $report['preflight'] = preflight($docroot, $cfg);
    }
    if (in_array($mode, array('scan', 'report'), true)) {
        $report['scan'] = scan($docroot, $cfg, $windowDays, $self);
    }
    if (in_array($mode, array('verify', 'report'), true)) {
        $report['verify'] = verify($docroot, $cfg);
    }
    if ($mode === 'install') {
        $report['install'] = install_mode($docroot);
    }
    if ($mode === 'uninstall') {
        $report['uninstall'] = uninstall_mode($docroot);
    }
    if ($mode === 'enforce') {
        $report['scan']    = scan($docroot, $cfg, $windowDays, $self);   // pre-enforce discovery
        $report['enforce'] = enforce_mode($docroot, $cfg, $report['scan']);
    }
    if (!in_array($mode, array('preflight', 'scan', 'verify', 'report', 'install', 'uninstall', 'enforce'), true)) {
        $report['errors'][] = "unknown mode '$mode'";
    }
} catch (Exception $e) {
    $report['errors'][] = 'phase error: ' . $e->getMessage();
}

echo json_encode($report, $JSON_FLAGS);

/* ================================================================ helpers */

function probe_env() {
    $disabled = array_filter(array_map('trim', explode(',', (string) ini_get('disable_functions'))));
    $procUser = null;
    if (function_exists('posix_getpwuid') && function_exists('posix_geteuid')) {
        $pw = posix_getpwuid(posix_geteuid());
        $procUser = (is_array($pw) && isset($pw['name'])) ? $pw['name'] : null;
    }
    return array(
        'disable_functions'  => array_values($disabled),
        'open_basedir'       => (string) ini_get('open_basedir'),
        'max_execution_time' => (int) ini_get('max_execution_time'),
        'unlink_disabled'    => in_array('unlink', $disabled, true),
        'rename_disabled'    => in_array('rename', $disabled, true),
        'exec_disabled'      => in_array('exec', $disabled, true),
        'process_user'       => $procUser,
    );
}

function preflight($docroot, $cfg) {
    $out = array(
        'is_joomla'       => false,
        'joomla_version'  => null,
        'joomla_major'    => null,
        'config_readable' => $cfg !== null,
        'jce'             => array('installed' => false, 'source' => 'none', 'version' => null,
                                   'edition' => null, 'enabled' => null, 'update_needed' => null),
        'security_patch'  => array('installed' => false, 'version' => null),
    );

    $out['is_joomla'] = is_file($docroot . '/configuration.php')
                        && is_dir($docroot . '/administrator')
                        && is_dir($docroot . '/libraries');

    // Joomla version — administrator/manifests/files/joomla.xml is stable across J3/4/5.
    $man = $docroot . '/administrator/manifests/files/joomla.xml';
    if (is_file($man) && ($xml = @file_get_contents($man)) !== false
        && preg_match('~<version>\s*([0-9][0-9.]+)\s*</version>~', $xml, $m)) {
        $out['joomla_version'] = $m[1];
        $out['joomla_major']   = (int) strtok($m[1], '.');
    }

    // JCE via disk manifest (authoritative for on-disk files)
    $jceXml = $docroot . '/administrator/components/com_jce/jce.xml';
    if (is_file($jceXml) && ($x = @file_get_contents($jceXml)) !== false
        && preg_match('~<version>\s*([0-9][0-9.]+)\s*</version>~', $x, $m)) {
        $out['jce']['installed'] = true;
        $out['jce']['source']    = 'disk';
        $out['jce']['version']   = $m[1];
    }

    // JCE via #__extensions (authoritative for what Joomla thinks is installed)
    $h = ro_db_connect($cfg);
    if ($h) {
        $p = db_prefix($cfg);
        $rows = ro_db_rows($h, "SELECT element, enabled, manifest_cache FROM `{$p}extensions`
                                WHERE element IN ('pkg_jce','com_jce','jcepro') OR element LIKE 'jce%'");
        foreach ($rows as $r) {
            $mc = json_decode((string) $r['manifest_cache'], true);
            $ver = (is_array($mc) && isset($mc['version'])) ? $mc['version'] : null;
            if ($r['element'] === 'pkg_jce' || ($r['element'] === 'com_jce' && !$out['jce']['version'])) {
                $out['jce']['installed'] = true;
                $out['jce']['source']    = 'extensions';
                if ($ver) { $out['jce']['version'] = $ver; }
                $out['jce']['enabled']   = (int) $r['enabled'];
            }
            if ($r['element'] === 'jcepro') { $out['jce']['edition'] = 'pro'; }
        }
        if ($out['jce']['edition'] === null && is_file($docroot . '/plugins/system/jcepro/jcepro.php')) {
            $out['jce']['edition'] = 'pro';
        }
        // Legacy CVE security patch (a 'file' extension) applied?
        $prow = ro_db_rows($h, "SELECT manifest_cache FROM `{$p}extensions`
                                WHERE element = '" . PATCH_ELEMENT . "' AND type = 'file' LIMIT 1");
        if ($prow) {
            $out['security_patch']['installed'] = true;
            $pmc = json_decode((string) $prow[0]['manifest_cache'], true);
            $out['security_patch']['version'] = (is_array($pmc) && isset($pmc['version'])) ? $pmc['version'] : null;
        }
        ro_db_close($h);
    }

    if ($out['jce']['version']) {
        $out['jce']['update_needed'] = version_compare($out['jce']['version'], TARGET_JCE, '<');
    }
    return $out;
}

function scan($docroot, $cfg, $windowDays, $self) {
    $cutoff = time() - $windowDays * 86400;

    // Roots: primary = Joomla tmp (CVE-2026-48907 landing zone); secondary = images/, media/.
    $tmp = ($cfg && !empty($cfg->tmp_path) && is_dir($cfg->tmp_path)) ? $cfg->tmp_path : $docroot . '/tmp';
    $roots = array();
    foreach (array($tmp, $docroot . '/images', $docroot . '/media') as $r) {
        if (is_dir($r)) { $roots[] = rtrim($r, '/\\'); }
    }

    $out = array(
        'window_days' => $windowDays,
        'roots'       => $roots,
        'files'       => array(),
        'htaccess'    => array(),
        'truncated'   => false,
        'files_seen'  => 0,
        'profiles'    => null,
        'summary'     => array(),
    );

    $count = 0;
    foreach ($roots as $root) {
        walk($root, $self, $out, $count, $cutoff);
        if ($out['truncated']) { break; }
    }

    // Database: JCE editor profiles (only if the table exists).
    $out['profiles'] = scan_profiles($cfg, $windowDays);

    $out['summary'] = array(
        'files_flagged'      => count($out['files']),
        'payloads_in_window' => count(array_filter($out['files'], 'flt_in_window')),
        'timestomped'        => count(array_filter($out['files'], 'flt_timestomp')),
        'double_extension'   => count(array_filter($out['files'], 'flt_double_extension')),
        'malicious_htaccess' => count($out['htaccess']),
        'profiles_added'     => $out['profiles']['added_recent'] ? count($out['profiles']['added_recent']) : 0,
        'profiles_disabled'  => $out['profiles']['recently_disabled'] ? count($out['profiles']['recently_disabled']) : 0,
    );
    return $out;
}

// array_filter predicates (named callables — closures would also work, these keep parity tidy)
function flt_in_window($f)        { return !empty($f['in_window']); }
function flt_timestomp($f)        { return !empty($f['timestomp']); }
function flt_double_extension($f) { return !empty($f['double_extension']); }

function walk($root, $self, &$out, &$count, $cutoff) {
    try {
        $flags = FilesystemIterator::SKIP_DOTS | FilesystemIterator::CURRENT_AS_FILEINFO;
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($root, $flags),   // does NOT follow symlinks by default
            RecursiveIteratorIterator::SELF_FIRST
        );
    } catch (Exception $e) {
        $out['errors_walk'][] = "$root: " . $e->getMessage();
        return;
    }

    foreach ($it as $info) {
        if ($count >= MAX_FILES) { $out['truncated'] = true; return; }
        $count++; $out['files_seen'] = $count;
        $path = $info->getPathname();
        if (str_contains($path, DIRECTORY_SEPARATOR . QUARANTINE_DIR . DIRECTORY_SEPARATOR)) { continue; }
        if ($info->isLink()) { continue; }                  // never follow/inspect symlinks
        if (!$info->isFile()) { continue; }
        $name = $info->getFilename();

        // Malicious .htaccess (makes non-PHP files execute as PHP)
        if (strcasecmp($name, '.htaccess') === 0) {
            $body = @file_get_contents($path, false, null, 0, 8192);
            if ($body !== false && preg_match(
                '~(AddType\s+application/x-httpd-php|AddHandler\b[^\n]*php|SetHandler\b[^\n]*php|php_flag\s+engine\s+on|php_value\s+engine)~i',
                $body, $mm)) {
                $out['htaccess'][] = array(
                    'path'   => $path,
                    'reason' => 'enables PHP execution in an upload directory',
                    'match'  => trim($mm[0]),
                );
            }
            continue;
        }

        if (basename($path) === $self) { continue; }        // never flag ourselves
        if (!preg_match(PHP_EXT_RE, $name)) { continue; }   // only PHP-executable files

        $mtime = @$info->getMTime(); if (!$mtime) { $mtime = 0; }
        $ctime = @$info->getCTime(); if (!$ctime) { $ctime = 0; }
        $dbl   = (bool) preg_match(DBL_EXT_RE, $name);
        $inWin = ($mtime >= $cutoff) || ($ctime >= $cutoff);
        // timestomp: mtime materially older than ctime (claims old, inode changed recently)
        $timestomp = ($mtime > 0 && $ctime > 0 && ($ctime - $mtime) > 86400);
        $sha = @hash_file('sha256', $path); if ($sha === false) { $sha = null; }

        $out['files'][] = array(
            'path'             => $path,
            'root'             => $root,
            'size'             => $info->getSize(),
            'mtime'            => $mtime ? gmdate('c', $mtime) : null,
            'ctime'            => $ctime ? gmdate('c', $ctime) : null,
            'sha256'           => $sha,
            'ext'              => strtolower((string) pathinfo($name, PATHINFO_EXTENSION)),
            'double_extension' => $dbl,
            'in_window'        => $inWin,
            'timestomp'        => $timestomp,
            'level'            => ($dbl || $timestomp) ? 'high' : 'medium',
        );
    }
}

function scan_profiles($cfg, $windowDays) {
    $res = array('table' => null, 'all_count' => 0,
                 'added_recent' => array(), 'recently_disabled' => array(), 'anomalous' => array());
    $h = ro_db_connect($cfg);
    if (!$h) { return $res; }
    $p = db_prefix($cfg);
    $tbl = $p . 'wf_profiles';

    if (!ro_db_exists_table($h, $tbl)) { ro_db_close($h); return $res; }
    $res['table'] = $tbl;
    $w = (int) $windowDays;

    $cols = 'id,name,created,created_by,modified,modified_by,published';
    $cntRows = ro_db_rows($h, "SELECT COUNT(*) c FROM `$tbl`");
    $res['all_count'] = (int) (isset($cntRows[0]['c']) ? $cntRows[0]['c'] : 0);
    $res['added_recent'] = ro_db_rows($h,
        "SELECT $cols FROM `$tbl` WHERE created >= (NOW() - INTERVAL $w DAY) ORDER BY created DESC");
    $res['recently_disabled'] = ro_db_rows($h,
        "SELECT $cols FROM `$tbl` WHERE published = 0 AND modified >= (NOW() - INTERVAL $w DAY) ORDER BY modified DESC");
    $res['anomalous'] = ro_db_rows($h,
        "SELECT $cols FROM `$tbl` WHERE created_by = 0 OR name NOT IN ('Default','Front End') ORDER BY id DESC");

    // Flag the strongest IOC explicitly: unauthenticated import => created_by = 0
    foreach ($res['added_recent'] as &$r) { $r['ioc_created_by_zero'] = ((int) $r['created_by'] === 0); }
    unset($r);
    ro_db_close($h);
    return $res;
}

function verify($docroot, $cfg) {
    $pf = preflight($docroot, $cfg);
    $ver = $pf['jce']['version'];
    $patched = !empty($pf['security_patch']['installed']);
    return array(
        'jce_version'    => $ver,
        'target'         => TARGET_JCE,
        'up_to_date'     => $ver ? version_compare($ver, TARGET_JCE, '>=') : false,
        'vuln_closed'    => ($ver && version_compare($ver, FIRST_FIXED_JCE, '>=')) || $patched,
        'security_patch' => $pf['security_patch'],
        'enabled'        => $pf['jce']['enabled'],
        'note'           => $ver ? null : ($patched ? null : 'JCE not detected (not installed, or DB unreadable)'),
    );
}

/* -------------------------------------------------------- install (mutating) */

function joomla_major_disk($docroot) {
    $man = $docroot . '/administrator/manifests/files/joomla.xml';
    if (is_file($man) && ($x = @file_get_contents($man)) !== false
        && preg_match('~<version>\s*([0-9]+)\.~', $x, $m)) {
        return (int) $m[1];
    }
    return 0;
}

function install_mode($docroot) {
    $out = array('requested_pkg' => null, 'joomla_major' => null, 'before' => null, 'after' => null,
                 'installer_returned' => false, 'success' => false, 'messages' => array(), 'backup_rows' => null,
                 'bootstrap_output' => '', 'errors' => array(),
                 'note' => 'authoritative post-state is a separate verify request');

    $pkg = basename((string) (isset($_REQUEST['pkg']) ? $_REQUEST['pkg'] : ''));   // strip any path (no traversal)
    $out['requested_pkg'] = $pkg;
    if ($pkg === '' || !preg_match('/\.zip$/i', $pkg)) {
        $out['errors'][] = 'pkg param must name a .zip deployed in the docroot'; return $out;
    }
    $zip = $docroot . '/' . $pkg;
    if (!is_file($zip)) { $out['errors'][] = "package not found in docroot: $pkg"; return $out; }

    $major = joomla_major_disk($docroot);
    $out['joomla_major'] = $major;
    if ($major < 3) { $out['errors'][] = 'could not determine Joomla major version'; return $out; }

    ob_start();
    try {
        boot_joomla($docroot, $major);
        $out['before']      = jce_version_db();
        $out['backup_rows'] = backup_jce_rows();
        $snap = install_dirs_snapshot($docroot);
        $ok = ($major >= 4) ? install_pkg_j4($zip, $out) : install_pkg_j3($zip, $out);
        $out['installer_returned'] = (bool) $ok;      // Joomla can return false on over-install even on success
        $aerr = null;
        $out['after'] = jce_version_db($aerr);        // may be null in the same request; orchestrator verifies separately
        if ($aerr) { $out['errors'][] = 'after-read: ' . $aerr; }
        clear_joomla_cache();
        $out['leftover_dirs_removed'] = cleanup_new_install_dirs($docroot, $snap);  // Joomla can leave install_* extract dirs
        $out['success'] = $out['after'] !== null && version_compare($out['after'], '0', '>');
    } catch (Exception $e) {
        $out['errors'][] = 'install: ' . $e->getMessage();
    }
    $stray = trim((string) ob_get_clean());
    if ($stray !== '') { $out['bootstrap_output'] = substr($stray, 0, 500); }
    return $out;
}

function install_dirs_snapshot($docroot) {
    $dirs = array();
    foreach (array($docroot, $docroot . '/tmp') as $base) {
        foreach ((array) @glob($base . '/install_*', GLOB_ONLYDIR) as $d) { $dirs[$d] = true; }
    }
    return $dirs;
}

function cleanup_new_install_dirs($docroot, $before) {
    $removed = array();
    foreach (array($docroot, $docroot . '/tmp') as $base) {
        foreach ((array) @glob($base . '/install_*', GLOB_ONLYDIR) as $d) {
            if (!isset($before[$d]) && rmtree_local($d)) { $removed[] = $d; }
        }
    }
    return $removed;
}

function rmtree_local($dir) {
    if (!is_dir($dir) || is_link($dir)) { return false; }
    foreach ((array) @scandir($dir) as $it) {
        if ($it === '.' || $it === '..') { continue; }
        $p = $dir . '/' . $it;
        if (is_dir($p) && !is_link($p)) { rmtree_local($p); } else { @unlink($p); }
    }
    return @rmdir($dir);
}

/* ------------------------------------------------------ uninstall JCE (mutating) */

// Remove JCE entirely (last-resort mitigation for sites with no compatible JCE version).
function uninstall_mode($docroot) {
    $out = array('joomla_major' => null, 'before' => null, 'after' => null, 'removed' => array(),
                 'installer_returned' => false, 'success' => false, 'messages' => array(),
                 'bootstrap_output' => '', 'errors' => array(),
                 'note' => 'authoritative post-state is a separate verify request');
    $major = joomla_major_disk($docroot);
    $out['joomla_major'] = $major;
    if ($major < 3) { $out['errors'][] = 'could not determine Joomla major version'; return $out; }

    ob_start();
    try {
        boot_joomla($docroot, $major);
        $out['before'] = jce_version_db();
        $snap = install_dirs_snapshot($docroot);
        // package first (cascades to children), then component/plugins, then the file patch
        $order = array('package' => 1, 'component' => 2, 'plugin' => 3, 'module' => 4, 'file' => 5, 'library' => 6);
        for ($pass = 0; $pass < 4; $pass++) {
            $rows = jce_extension_rows();
            if (!$rows) { break; }
            usort($rows, uninstall_order_cmp($order));
            $did = false;
            foreach ($rows as $r) {
                $ok = uninstall_ext((int) $r['extension_id'], (string) $r['type'], $major);
                $out['removed'][] = array('element' => $r['element'], 'type' => $r['type'], 'id' => (int) $r['extension_id'], 'ok' => (bool) $ok);
                if ($ok) { $out['installer_returned'] = true; $did = true; }
            }
            collect_messages($out);
            if (!$did) { break; }
        }
        clear_joomla_cache();
        cleanup_new_install_dirs($docroot, $snap);
        $out['after']   = jce_version_db();
        $out['success'] = ($out['after'] === null);
    } catch (Exception $e) {
        $out['errors'][] = 'uninstall: ' . $e->getMessage();
    }
    $stray = trim((string) ob_get_clean());
    if ($stray !== '') { $out['bootstrap_output'] = substr($stray, 0, 500); }
    return $out;
}

// Returns a comparator closure ordering uninstall by extension type (no <=> on 5.3).
function uninstall_order_cmp($order) {
    return function ($a, $b) use ($order) {
        $av = isset($order[$a['type']]) ? $order[$a['type']] : 9;
        $bv = isset($order[$b['type']]) ? $order[$b['type']] : 9;
        return ($av < $bv) ? -1 : (($av > $bv) ? 1 : 0);
    };
}

function jce_extension_rows() {
    try {
        $db = \Joomla\CMS\Factory::getDbo();
        $db->setQuery("SELECT extension_id, element, type, folder FROM #__extensions
                       WHERE element IN ('pkg_jce','com_jce','jce','jcepro','mediajce','" . PATCH_ELEMENT . "')
                       ORDER BY extension_id");
        return (array) $db->loadAssocList();
    } catch (Exception $e) { return array(); }
}

function uninstall_ext($id, $type, $major) {
    try {
        if ($major >= 4) { return (bool) \Joomla\CMS\Installer\Installer::getInstance()->uninstall($type, $id); }
        \jimport('joomla.installer.installer');
        return (bool) \JInstaller::getInstance()->uninstall($type, $id);
    } catch (Exception $e) { return false; }
}

function boot_joomla($docroot, $major) {
    if (!defined('_JEXEC'))     { define('_JEXEC', 1); }
    if (!defined('JPATH_BASE')) { define('JPATH_BASE', $docroot . '/administrator'); }
    require_once JPATH_BASE . '/includes/defines.php';
    require_once JPATH_BASE . '/includes/framework.php';
    if ($major >= 4) {
        // Register extension PSR-4 namespaces — normally done inside app->execute() (which we skip),
        // and required so installer plugin events (e.g. plg_extension_finder) can load their classes.
        try {
            \JLoader::register('JNamespacePsr4Map', JPATH_LIBRARIES . '/namespacemap.php');
            $nsMap = new \JNamespacePsr4Map();
            if (method_exists($nsMap, 'ensureMapFileExists')) { $nsMap->ensureMapFileExists(); }
            $nsMap->load();
        } catch (Exception $e) { /* proceed; some setups autoload without it */ }
        $c = \Joomla\CMS\Factory::getContainer();
        $c->alias('session.web', 'session.web.administrator')
          ->alias('session', 'session.web.administrator')
          ->alias('Joomla\\CMS\\Session\\Session', 'session.web.administrator')
          ->alias('Joomla\\Session\\Session', 'session.web.administrator')
          ->alias('Joomla\\Session\\SessionInterface', 'session.web.administrator');
        $app = $c->get('Joomla\\CMS\\Application\\AdministratorApplication');
        \Joomla\CMS\Factory::$application = $app;
    } else {
        \JFactory::getApplication('administrator');
    }
}

function install_pkg_j4($zip, &$out) {
    $pkg = \Joomla\CMS\Installer\InstallerHelper::unpack($zip, true);
    $dir = isset($pkg['extractdir']) ? $pkg['extractdir'] : (isset($pkg['dir']) ? $pkg['dir'] : null);
    if (!$dir || !is_dir($dir)) { $out['errors'][] = 'unpack failed'; return false; }
    $ok = \Joomla\CMS\Installer\Installer::getInstance()->install($dir);
    collect_messages($out);
    \Joomla\CMS\Installer\InstallerHelper::cleanupInstall($zip, $dir);
    return (bool) $ok;
}

function install_pkg_j3($zip, &$out) {
    \jimport('joomla.installer.installer');
    \jimport('joomla.installer.helper');
    $pkg = \JInstallerHelper::unpack($zip, true);
    $dir = isset($pkg['dir']) ? $pkg['dir'] : (isset($pkg['extractdir']) ? $pkg['extractdir'] : null);
    if (!$dir || !is_dir($dir)) { $out['errors'][] = 'unpack failed'; return false; }
    $ok = \JInstaller::getInstance()->install($dir);
    collect_messages($out);
    \JInstallerHelper::cleanupInstall($zip, $dir);
    return (bool) $ok;
}

function collect_messages(&$out) {
    try {
        foreach ((array) \Joomla\CMS\Factory::getApplication()->getMessageQueue() as $m) {
            $type = isset($m['type']) ? $m['type'] : '';
            $msg  = isset($m['message']) ? $m['message'] : '';
            $out['messages'][] = $type . ': ' . strip_tags((string) $msg);
        }
    } catch (Exception $e) { /* ignore */ }
}

function jce_version_db(&$err = null) {
    try {
        $db = \Joomla\CMS\Factory::getDbo();
        foreach (array("element = 'pkg_jce' AND type = 'package'", "element = 'com_jce'") as $where) {
            $db->setQuery("SELECT manifest_cache FROM #__extensions WHERE $where LIMIT 1");
            $mc = $db->loadResult();
            if ($mc) { $j = json_decode($mc, true); if (is_array($j) && !empty($j['version'])) { return $j['version']; } }
        }
    } catch (Exception $e) { $err = $e->getMessage(); }
    return null;
}

function backup_jce_rows() {
    try {
        $db = \Joomla\CMS\Factory::getDbo();
        $db->setQuery("SELECT extension_id, name, element, type, folder, enabled, manifest_cache
                       FROM #__extensions WHERE element LIKE 'jce%' OR element IN ('com_jce','pkg_jce')");
        return (array) $db->loadAssocList();
    } catch (Exception $e) { return array('error' => $e->getMessage()); }
}

function clear_joomla_cache() {
    try { \Joomla\CMS\Factory::getCache()->clean(); } catch (Exception $e) { /* ignore */ }
}

/* -------------------------------------------------------- enforce (mutating) */

/**
 * Neutralise IOCs. CONSERVATIVE by default: only quarantines high-confidence payloads
 * (files under the Joomla tmp/ dir, double-extension, or timestomped) plus malicious
 * upload-dir .htaccess. Pass aggressive=1 to quarantine every flagged PHP file.
 * Each moved file's hash + full stat is returned in the JSON response (persisted host-side by the
 * orchestrator — no log is left in the document root). Everything is reversible (move, not delete;
 * profiles flip published, not drop). The orchestrator then relocates the quarantine dir off the
 * docroot to the host output folder, leaving only the protective hardening .htaccess behind.
 */
function enforce_mode($docroot, $cfg, $scan) {
    $out = array('quarantine_dir' => null, 'aggressive' => !empty($_REQUEST['aggressive']),
                 'quarantined' => array(), 'hardened' => array(), 'profiles_disabled' => array(),
                 'skipped' => array(), 'errors' => array());

    $tmpRoot = ($cfg && !empty($cfg->tmp_path) && is_dir($cfg->tmp_path)) ? rtrim($cfg->tmp_path, '/\\') : $docroot . '/tmp';

    // Quarantine dir is created lazily (only if something is actually quarantined) so a clean
    // site gets nothing left in its docroot.
    $qdir = $docroot . '/' . QUARANTINE_DIR;
    $out['quarantine_dir'] = $qdir;

    // 1. quarantine payload files
    foreach ($scan['files'] as $f) {
        $path  = $f['path'];
        $inTmp = ($path === $tmpRoot) || str_starts_with($path, $tmpRoot . DIRECTORY_SEPARATOR);
        $hi    = $out['aggressive'] || $inTmp || !empty($f['double_extension']) || !empty($f['timestomp']);
        if (!$hi) { $out['skipped'][] = array('path' => $path, 'reason' => 'low-confidence (report-only; use aggressive=1)'); continue; }
        $r = quarantine_file($path, $qdir, array('kind' => 'payload', 'flags' => $f));
        if ($r['ok']) { $out['quarantined'][] = $r['record']; } elseif (!empty($r['error'])) { $out['errors'][] = $r['error']; }
    }
    // 2. quarantine malicious .htaccess (must precede hardening so we can write our own)
    foreach ($scan['htaccess'] as $hh) {
        $r = quarantine_file($hh['path'], $qdir, array('kind' => 'htaccess', 'match' => isset($hh['match']) ? $hh['match'] : null));
        if ($r['ok']) { $out['quarantined'][] = $r['record']; } elseif (!empty($r['error'])) { $out['errors'][] = $r['error']; }
    }
    // 3. harden upload dirs (Apache only — report status honestly); skipped with no_harden=1
    if (empty($_REQUEST['no_harden'])) {
        foreach (array($tmpRoot, $docroot . '/images', $docroot . '/media') as $dir) {
            if (is_dir($dir)) { $out['hardened'][] = harden_dir($dir); }
        }
    }
    // 4. optional: disable rogue JCE profiles (reversible)
    if (!empty($_REQUEST['disable_profiles'])) {
        $out['profiles_disabled'] = disable_rogue_profiles($cfg);
    }
    return $out;
}

function harden_quarantine_dir($qdir) {
    if (!is_file("$qdir/.htaccess")) { @file_put_contents("$qdir/.htaccess", "Require all denied\nDeny from all\n"); }
    if (!is_file("$qdir/index.html")) { @file_put_contents("$qdir/index.html", ''); }
    if (!is_file("$qdir/web.config")) {
        @file_put_contents("$qdir/web.config",
            "<?xml version=\"1.0\"?><configuration><system.webServer><authorization>" .
            "<deny users=\"*\"/></authorization></system.webServer></configuration>");
    }
}

function quarantine_file($path, $qdir, $meta) {
    if (str_contains($path, DIRECTORY_SEPARATOR . QUARANTINE_DIR . DIRECTORY_SEPARATOR)) { return array('ok' => false); }
    clearstatcache(true, $path);
    if (!is_file($path)) { return array('ok' => false); }
    if (!is_dir($qdir)) {                                   // create + harden on first use only
        if (!@mkdir($qdir, 0700, true) && !is_dir($qdir)) { return array('ok' => false, 'error' => "could not create quarantine dir: $qdir"); }
        harden_quarantine_dir($qdir);
    }

    // capture hash + full stat -> returned in the JSON response (persisted host-side; no docroot log)
    $sha  = @hash_file('sha256', $path); if ($sha === false) { $sha = null; }
    $st   = @stat($path); if ($st === false) { $st = array(); }
    $nonce = $sha ? $sha : bin2hex(random_bytes(6));
    $dest = $qdir . '/' . substr($nonce, 0, 12) . '_' . basename($path) . '.php-disabled';
    $record = array(
        'original_path' => $path, 'quarantined_to' => $dest, 'sha256' => $sha,
        'size'  => isset($st['size']) ? $st['size'] : null,
        'mtime' => isset($st['mtime']) ? gmdate('c', $st['mtime']) : null,
        'ctime' => isset($st['ctime']) ? gmdate('c', $st['ctime']) : null,
        'perms' => isset($st['mode']) ? substr(sprintf('%o', $st['mode']), -4) : null,
        'utc'   => gmdate('c'), 'meta' => $meta,
    );

    if (!@rename($path, $dest)) {                       // fall back to copy+unlink (cross-device / restrictions)
        if (!@copy($path, $dest) || !@unlink($path)) {
            return array('ok' => false, 'error' => "could not quarantine: $path");
        }
    }
    @chmod($dest, 0000);
    return array('ok' => true, 'record' => $record);
}

function harden_dir($dir) {
    $file = $dir . '/.htaccess';
    $marker = '# jce-remediate-hardening';
    $body = "$marker\n"
          . "<IfModule mod_php.c>\nphp_flag engine off\n</IfModule>\n"
          . "<FilesMatch \"\\.(php|php[0-9]?|phtml|phar|pht|phps)$\">\nRequire all denied\n</FilesMatch>\n";
    if (is_file($file)) {
        $cur = (string) @file_get_contents($file);
        if (str_contains($cur, $marker)) { return array('dir' => $dir, 'status' => 'already-hardened'); }
        return array('dir' => $dir, 'status' => 'skipped-existing-htaccess');   // don't clobber a legit one
    }
    return array('dir' => $dir, 'status' => @file_put_contents($file, $body) !== false ? 'hardened' : 'failed',
                 'note' => 'Apache/AllowOverride only; Nginx/LiteSpeed need vhost rules');
}

function disable_rogue_profiles($cfg) {
    $h = ro_db_connect($cfg); if (!$h) { return array(); }
    $p = db_prefix($cfg); $tbl = $p . 'wf_profiles';
    if (!ro_db_exists_table($h, $tbl)) { ro_db_close($h); return array(); }
    $before = ro_db_rows($h, "SELECT id,name,created,created_by FROM `$tbl` WHERE created_by = 0 AND published = 1");
    if ($before) { ro_db_exec($h, "UPDATE `$tbl` SET published = 0 WHERE created_by = 0 AND published = 1"); }
    ro_db_close($h);
    return $before;   // reversible: these ids were flipped 1 -> 0
}

/* ---------------------------------------------------------------- DB utils

   Runtime-selected read-only driver so this one file works on every PHP the fleet runs:
   mysqli (modern) -> mysql (legacy 5.3-only hosts) -> PDO. A handle is array('drv'=>..,'link'=>..).
   Only the direct read-only DB access (preflight/scan_profiles/disable_rogue_profiles) uses this;
   install/uninstall talk through Joomla's own DBO, which Joomla configures for us. */

function ro_db_driver() {
    if (function_exists('mysqli_connect')) { return 'mysqli'; }
    if (function_exists('mysql_connect'))  { return 'mysql'; }
    if (class_exists('PDO')) {
        $drivers = PDO::getAvailableDrivers();
        if (in_array('mysql', $drivers, true)) { return 'pdo'; }
    }
    return null;
}

function ro_db_connect($cfg) {
    if (!$cfg || empty($cfg->host)) { return null; }
    $host = $cfg->host; $port = 3306;
    if (strpos($host, ':') !== false) {
        $parts = explode(':', $host, 2);
        $host = $parts[0];
        $pp = (int) $parts[1];
        if ($pp > 0) { $port = $pp; }
    }
    $user = isset($cfg->user) ? $cfg->user : '';
    $pass = isset($cfg->password) ? $cfg->password : '';
    $name = isset($cfg->db) ? $cfg->db : '';
    $drv = ro_db_driver();

    if ($drv === 'mysqli') {
        $link = @mysqli_connect($host, $user, $pass, $name, $port);
        return $link ? array('drv' => 'mysqli', 'link' => $link) : null;
    }
    if ($drv === 'mysql') {
        $link = @mysql_connect($host . ':' . $port, $user, $pass);
        if ($link && @mysql_select_db($name, $link)) { return array('drv' => 'mysql', 'link' => $link); }
        return null;
    }
    if ($drv === 'pdo') {
        try {
            $pdo = new PDO('mysql:host=' . $host . ';port=' . $port . ';dbname=' . $name, $user, $pass);
            $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_SILENT);
            return array('drv' => 'pdo', 'link' => $pdo);
        } catch (Exception $e) { return null; }
    }
    return null;
}

function db_prefix($cfg) {
    $p = isset($cfg->dbprefix) ? $cfg->dbprefix : '';
    return preg_replace('/[^A-Za-z0-9_]/', '', (string) $p);
}

function ro_db_rows($h, $sql) {
    if (!$h) { return array(); }
    $rows = array();
    if ($h['drv'] === 'mysqli') {
        $r = @mysqli_query($h['link'], $sql);
        if (!$r) { return array(); }
        while ($row = mysqli_fetch_assoc($r)) { $rows[] = $row; }
        return $rows;
    }
    if ($h['drv'] === 'mysql') {
        $r = @mysql_query($sql, $h['link']);
        if (!$r) { return array(); }
        while ($row = mysql_fetch_assoc($r)) { $rows[] = $row; }
        return $rows;
    }
    // pdo
    try {
        $stmt = $h['link']->query($sql);
        if (!$stmt) { return array(); }
        $all = $stmt->fetchAll(PDO::FETCH_ASSOC);
        return is_array($all) ? $all : array();
    } catch (Exception $e) { return array(); }
}

function ro_db_exec($h, $sql) {
    if (!$h) { return false; }
    if ($h['drv'] === 'mysqli') { return (bool) @mysqli_query($h['link'], $sql); }
    if ($h['drv'] === 'mysql')  { return (bool) @mysql_query($sql, $h['link']); }
    try { return $h['link']->exec($sql) !== false; } catch (Exception $e) { return false; }
}

// Table names here are pre-sanitized ($prefix is [A-Za-z0-9_]; suffix is a literal), so no escaping
// is needed for the LIKE — which sidesteps the per-driver escape-signature differences.
function ro_db_exists_table($h, $tbl) {
    return count(ro_db_rows($h, "SHOW TABLES LIKE '" . $tbl . "'")) > 0;
}

function ro_db_close($h) {
    if (!$h) { return; }
    if ($h['drv'] === 'mysqli') { @mysqli_close($h['link']); }
    elseif ($h['drv'] === 'mysql') { @mysql_close($h['link']); }
    // pdo closes on unset / request end
}
