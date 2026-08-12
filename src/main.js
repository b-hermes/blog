function toggleTheme() {
  var root = document.documentElement;
  var isAmber = root.classList.toggle('amber');
  try { localStorage.setItem('theme', isAmber ? 'amber' : 'paper'); } catch (e) {}
  var fav = document.querySelector("link[rel='icon']");
  if (fav) {
    var color = isAmber ? '%23ffb000' : '%231f7a4d';
    fav.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='10 0 80 100'><text x='10' y='.9em' font-size='100' font-weight='bold' fill='" + color + "'>⟩</text></svg>";
  }
}

window.addEventListener('scroll', function () {
  var b = document.getElementById('topBtn');
  if (b) b.classList.toggle('show', window.scrollY > 400);
});

// copy buttons on code blocks
document.querySelectorAll('.wrap pre').forEach(function (pre) {
  var wrap = document.createElement('div');
  wrap.className = 'pre-wrap';
  pre.parentNode.insertBefore(wrap, pre);
  wrap.appendChild(pre);
  var btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.textContent = 'copy';
  wrap.appendChild(btn);
  btn.addEventListener('click', function () {
    navigator.clipboard.writeText(pre.textContent).then(function () {
      btn.textContent = 'copied';
      setTimeout(function () { btn.textContent = 'copy'; }, 1500);
    });
  });
});

// typed name header
(function () {
  var text = 'bruno menna';
  var el = document.getElementById('typed');
  if (!el) return;
  var i = 0;
  (function type() {
    if (i <= text.length) { el.textContent = text.slice(0, i); i++; setTimeout(type, 80 + Math.random() * 40); }
  })();
})();

// home only: toggle the posts/talks/about sections by hash (no-op on post pages)
(function () {
  var pages = document.querySelectorAll('.page');
  if (!pages.length) return;
  function show(id) {
    var target = document.getElementById(id) || document.getElementById('posts');
    pages.forEach(function (p) { p.classList.remove('visible'); });
    document.querySelectorAll('nav a').forEach(function (a) { a.classList.remove('active'); });
    target.classList.add('visible');
    var na = document.querySelector('nav a[data-page="' + target.id + '"]');
    if (na) na.classList.add('active');
    window.scrollTo(0, 0);
  }
  function fromHash() { show(window.location.hash.slice(1) || 'posts'); }
  window.addEventListener('hashchange', fromHash);
  fromHash();
})();
