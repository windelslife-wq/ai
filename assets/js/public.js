(() => {
  const nav = document.querySelector('.pub-nav');
  const toggle = document.querySelector('.pub-toggle');
  if (!nav || !toggle) return;
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
})();
