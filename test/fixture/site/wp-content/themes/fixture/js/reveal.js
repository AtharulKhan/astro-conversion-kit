(function () {
  var sections = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    sections.forEach(function (el) { el.classList.add('in'); });
    return;
  }
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  sections.forEach(function (el) { observer.observe(el); });

  document.querySelectorAll('img.lazyload[data-src]').forEach(function (img) {
    img.src = img.getAttribute('data-src');
    if (img.getAttribute('data-srcset')) img.srcset = img.getAttribute('data-srcset');
    img.classList.remove('lazyload');
  });
})();
