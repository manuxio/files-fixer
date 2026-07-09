<?php
// shop.local shopping cart
session_start();
$cart = $_SESSION['cart'] ?? [];
echo count($cart) . " items in cart";
