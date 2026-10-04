<?php
defined('BASEPATH') or exit('No direct script access allowed');

require_once APPPATH . 'core/MY_Controller.php';

/** Authenticated workspace pages. Visitors are sent to /login. */
class App_Controller extends MY_Controller
{
    protected array $identity;

    public function __construct()
    {
        parent::__construct();
        $this->identity = $this->requireLogin();
    }
}
