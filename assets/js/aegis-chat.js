/* WINDELS Assistant — floating chat widget behaviour.
   Open/close animation (class-driven, so the panel transitions instead of
   popping), Escape/outside-click to close, aria wiring, and the grounded
   assistant endpoint call. No layout is touched from JS: positioning lives
   entirely in assets/css/chat-widget.css. */
(function () {
  'use strict';
  var root = document.getElementById('aegis-chat');
  if (!root || root.dataset.ready === '1') return;
  root.dataset.ready = '1';

  var launch = root.querySelector('.aegis-chat-launch');
  var panel = root.querySelector('.aegis-chat-panel');
  var close = root.querySelector('.aegis-chat-close');
  var form = root.querySelector('.aegis-chat-form');
  var input = form && form.querySelector('input[name="message"]');
  var messages = root.querySelector('.aegis-chat-messages');
  var endpoint = root.getAttribute('data-endpoint') || '/api/chat/respond';
  var closeTimer = null;

  function isOpen() { return root.classList.contains('is-open'); }

  function setOpen(open) {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    launch.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      panel.hidden = false;
      // Force a style flush so the transition from the closed state runs.
      void panel.offsetHeight;
      root.classList.add('is-open');
      if (input) input.focus({ preventScroll: true });
    } else {
      root.classList.remove('is-open');
      var done = function () {
        if (!isOpen()) panel.hidden = true;
        panel.removeEventListener('transitionend', done);
      };
      panel.addEventListener('transitionend', done);
      // Reduced-motion / no-transition fallback.
      closeTimer = setTimeout(done, 250);
    }
  }

  function addMessage(text, kind) {
    var item = document.createElement('div');
    item.className = 'aegis-chat-message ' + kind;
    item.textContent = text;
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
    return item;
  }

  launch.addEventListener('click', function () { setOpen(!isOpen()); });
  close.addEventListener('click', function () { setOpen(false); launch.focus({ preventScroll: true }); });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen()) setOpen(false);
  });
  document.addEventListener('click', function (event) {
    if (isOpen() && !root.contains(event.target)) setOpen(false);
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var message = input.value.trim();
    if (!message) return;
    input.value = '';
    addMessage(message, 'user');
    var pending = addMessage('Thinking…', 'agent pending');
    var button = form.querySelector('button');
    button.disabled = true;
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message })
    })
      .then(function (response) {
        return response.json().then(function (body) {
          if (!response.ok) throw new Error(body.error || 'The assistant is unavailable.');
          return body;
        });
      })
      .then(function (body) {
        pending.className = 'aegis-chat-message agent';
        pending.textContent = body.message || 'No response was returned.';
      })
      .catch(function (error) {
        pending.className = 'aegis-chat-message error';
        pending.textContent = error.message || 'The assistant is unavailable.';
      })
      .finally(function () { button.disabled = false; });
  });
}());
