<?php
// example.com landing page
require __DIR__ . '/config.php';

function render_home() {
    echo "<h1>Welcome to example.com</h1>";
    echo "<p>Everything is fine here.</p>";
}

render_home();
