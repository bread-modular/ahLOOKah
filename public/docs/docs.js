// ahLOOKah — documentation mobile sidebar toggle.
// Tiny progressive enhancement: no framework, no routing. Works without JS too
// (the sidebar is simply always visible on desktop via CSS).
(function () {
  'use strict';

  var body = document.body;
  var toggle = document.getElementById('menu-toggle');
  var backdrop = document.getElementById('sidebar-backdrop');

  if (!toggle || !backdrop) return;

  function setOpen(open) {
    body.classList.toggle('sidebar-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  }

  toggle.addEventListener('click', function () {
    setOpen(!body.classList.contains('sidebar-open'));
  });

  backdrop.addEventListener('click', function () {
    setOpen(false);
  });

  // Close the drawer when a nav link is chosen (mobile).
  var links = document.querySelectorAll('.sidebar a');
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener('click', function () {
      setOpen(false);
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setOpen(false);
  });
})();
