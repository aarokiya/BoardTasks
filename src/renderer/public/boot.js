// Runs synchronously before the stylesheet and app bundle so the first paint
// is already in the right theme. External (not inline) to satisfy script-src 'self'.
(function () {
  var b = window.boardtasks && window.boardtasks.boot;
  var t = (b && b.theme) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  var d = document.documentElement;
  d.dataset.theme = t;
  if (b && b.window) d.dataset.window = b.window;
  if (b && b.platform) d.dataset.platform = b.platform;
})();
