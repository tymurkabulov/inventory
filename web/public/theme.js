// Тема до первой отрисовки, чтобы не мигало. Тёмная — по умолчанию.
try {
  var t = localStorage.getItem('hz-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
