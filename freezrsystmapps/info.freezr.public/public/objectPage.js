/* objectPage.js - JavaScript for public object pages */

(function() {
  'use strict';

  /**
   * Initialize the page when DOM is ready
   */
  function init() {
    setupImageErrorHandlers();
  }

  /**
   * Handle image loading errors
   * Hides images with data-hide-on-error="true" attribute when they fail to load
   */
  function setupImageErrorHandlers() {
    document.querySelectorAll('img[data-hide-on-error="true"]').forEach(function(img) {
      // Check if already failed (for cached images)
      if (img.complete && img.naturalHeight === 0) {
        img.style.display = 'none';
      }
      
      img.addEventListener('error', function() {
        img.style.display = 'none';
      });
    });
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

