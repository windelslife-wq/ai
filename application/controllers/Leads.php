<?php
defined('BASEPATH') or exit('No direct script access allowed');
require_once APPPATH . 'core/App_Controller.php';
class Leads extends App_Controller {
 public function index(){ $this->load->view('leads/index'); }
 public function pipeline(){ $this->load->view('leads/index',['pipeline'=>true]); }
}
