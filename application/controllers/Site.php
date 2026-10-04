<?php
defined('BASEPATH') or exit('No direct script access allowed');

/** Public marketing website. No dashboard chrome and no login required. */
class Site extends MY_Controller
{
    public function index() { $this->page('home', 'Home', 'site/home'); }
    public function about() { $this->page('about', 'About', 'site/about'); }
    public function services() { $this->page('services', 'Services', 'site/services'); }
    public function how_it_works() { $this->page('how', 'How it works', 'site/how'); }
    public function locations() { $this->page('locations', 'Coverage', 'site/locations'); }
    public function safety() { $this->page('safety', 'Safety & trust', 'site/safety'); }
    public function faq() { $this->page('faq', 'FAQ', 'site/faq'); }
    public function contact() { $this->page('contact', 'Contact', 'site/contact'); }

    public function contact_submit()
    {
        $name = trim((string) $this->input->post('name'));
        $email = strtolower(trim((string) $this->input->post('email')));
        $message = trim((string) $this->input->post('message'));
        if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($message) < 10) {
            $this->session->set_flashdata('error', 'Enter your name, a valid email, and a message of at least 10 characters.');
            redirect('/contact');
            return;
        }
        $this->platform->model->audit->emit('CONTACT_INQUIRY', 'Public contact form received from ' . $name, [
            'name' => $name, 'email' => $email, 'message' => mb_substr($message, 0, 2000),
        ], 'visitor');
        $this->tryMail($name, $email, $message);
        $this->session->set_flashdata('notice', 'Thank you. Your message was recorded. If outbound mail is configured, a copy was sent to the site operator.');
        redirect('/contact');
    }

    private function tryMail(string $name, string $email, string $message): void
    {
        if (!\Aegis\Mailer::enabled()) return;
        $to = (string) (getenv('VP_MAIL_FROM') ?: getenv('MAIL_FROM_ADDRESS') ?: '');
        if ($to === '') return;
        $html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;color:#0f172a">'
            . '<h2 style="color:#2563eb">New contact message — WINDELS AI WORKFORCE</h2>'
            . '<p><b>From:</b> ' . htmlspecialchars($name) . ' &lt;' . htmlspecialchars($email) . '&gt;</p>'
            . '<hr style="border:0;border-top:1px solid #e2e8f0">'
            . '<p style="white-space:pre-wrap">' . htmlspecialchars($message) . '</p>'
            . '</div>';
        $text = "New contact message — WINDELS AI WORKFORCE\n\nFrom: {$name} <{$email}>\n\n{$message}";
        \Aegis\Mailer::send($this, $to, 'WINDELS AI WORKFORCE contact form', $html, $text, $email, $name);
    }

    private function page(string $active, string $title, string $view): void
    {
        $data = [
            'title' => $title,
            'active' => $active,
            'user' => $this->currentUser(),
            'notice' => $this->session->flashdata('notice'),
            'error' => $this->session->flashdata('error'),
            'languages' => count($this->platform->langlearn->languages()),
        ];
        $this->load->view('site/layout/header', $data);
        $this->load->view($view, $data);
        $this->load->view('site/layout/footer', $data);
    }
}
