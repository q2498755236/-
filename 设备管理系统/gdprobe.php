<?php echo json_encode(array("gd" => function_exists("imagecreatefromstring"), "resample" => function_exists("imagecopyresampled"), "loaded" => extension_loaded("gd")));
