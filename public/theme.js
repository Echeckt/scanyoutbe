/* ScanYTB — thème clair / sombre.
   Ce fichier est chargé depuis le <head> : il applique le thème avant
   l'affichage, pour éviter tout clignotement au chargement.
   Il est volontairement séparé du HTML : la politique de sécurité du
   serveur (helmet) interdit les scripts écrits directement dans la page. */
(function () {
  var STORAGE_KEY = 'scanytb-theme';
  var DARK_COLOR = '#0b0c0f';
  var LIGHT_COLOR = '#f3f3f1';
  var root = document.documentElement;

  function storedTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
  }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? LIGHT_COLOR : DARK_COLOR);

    var button = document.getElementById('themeToggle');
    if (button) {
      button.setAttribute('aria-label', theme === 'light' ? 'Passer en mode sombre' : 'Passer en mode clair');
    }

    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (error) {
      /* navigation privée ou stockage refusé : le thème reste valable pour la visite */
    }
  }

  function currentTheme() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  // Sombre par défaut, sauf si le visiteur a déjà choisi le clair.
  applyTheme(storedTheme() === 'light' ? 'light' : 'dark');

  document.addEventListener('DOMContentLoaded', function () {
    applyTheme(currentTheme());

    var button = document.getElementById('themeToggle');
    if (!button) return;

    button.addEventListener('click', function () {
      applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    });
  });
})();
