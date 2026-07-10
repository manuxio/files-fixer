<?php
session_start();
$total = array_sum($_SESSION['cart'] ?? []);
echo 'Total: ' . $total;
