// Раньше Horizon ставился как приложение и кэшировал себя service worker'ом.
// Теперь это обычный сайт: снимаем старый worker и его кэш, иначе у тех, кто
// успел установить, страница вечно приходила бы из кэша.
(function () {
  try {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      var had = regs.length > 0;
      regs.forEach(function (r) {
        r.unregister();
      });
      if (window.caches && caches.keys) {
        caches.keys().then(function (keys) {
          keys.forEach(function (k) {
            caches.delete(k);
          });
        });
      }
      // Страница уже отрисована из старого кэша — показываем свежую.
      if (had) setTimeout(function () { location.reload(); }, 300);
    });
  } catch (e) {
    /* приватный режим или запрет — просто работаем как обычный сайт */
  }
})();
