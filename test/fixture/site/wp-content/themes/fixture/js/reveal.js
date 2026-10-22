(function () {
  function loadImage(img) {
    img.src = img.getAttribute('data-src');
    if (img.getAttribute('data-srcset')) img.srcset = img.getAttribute('data-srcset');
    img.classList.remove('lazyload');
  }
  function show(el) {
    if (el.matches('img.lazyload[data-src]')) loadImage(el);
    else el.classList.add('in');
  }

  var targets = document.querySelectorAll('.reveal, img.lazyload[data-src]');
  if (!('IntersectionObserver' in window)) {
    targets.forEach(show);
    return;
  }
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        show(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  targets.forEach(function (el) { observer.observe(el); });
})();
