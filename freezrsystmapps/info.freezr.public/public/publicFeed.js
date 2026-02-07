/* publicFeed.js - JavaScript for the public feed page */

(function() {
  'use strict';

  const MAX_COLLAPSED_HEIGHT = 380;
  const CONTENT_CHECK_DELAY = 100; // ms to wait for images to load

  /**
   * Initialize the page when DOM is ready
   */
  function init() {
    setupCards();
    setupSearch();
    setupImageErrorHandlers();
    
    // Re-check card heights after images load
    window.addEventListener('load', function() {
      setTimeout(setupCards, CONTENT_CHECK_DELAY);
    });
    
    // Handle window resize
    window.addEventListener('resize', debounce(setupCards, 150));
  }

  /**
   * Set up all cards - check heights and add expanders
   */
  function setupCards() {
    const cards = document.querySelectorAll('.freezr_public_card');
    
    cards.forEach(function(card) {
      // Skip if already has expander
      if (card.querySelector('.freezr_expander_container')) {
        updateCardState(card);
        return;
      }
      
      // Check if card content exceeds max height
      const contentHeight = getContentHeight(card);
      
      if (contentHeight > MAX_COLLAPSED_HEIGHT) {
        addExpander(card);
        card.classList.add('freezr_collapsed');
      } else {
        card.classList.add('freezr_short');
      }
    });
  }

  /**
   * Get the natural height of card content
   */
  function getContentHeight(card) {
    // Temporarily remove constraints to measure
    const wasCollapsed = card.classList.contains('freezr_collapsed');
    card.classList.remove('freezr_collapsed');
    card.style.maxHeight = 'none';
    
    const height = card.scrollHeight;
    
    // Restore state
    if (wasCollapsed) {
      card.classList.add('freezr_collapsed');
    }
    card.style.maxHeight = '';
    
    return height;
  }

  /**
   * Add expander button to a card
   */
  function addExpander(card) {
    const container = document.createElement('div');
    container.className = 'freezr_expander_container';
    
    const button = document.createElement('button');
    button.className = 'freezr_expander_btn';
    button.innerHTML = '<span>more</span> <span class="arrow">▾</span>';
    
    button.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      toggleCard(card, button);
    });
    
    container.appendChild(button);
    card.appendChild(container);
  }

  /**
   * Toggle card expanded/collapsed state
   */
  function toggleCard(card, button) {
    const isCollapsed = card.classList.contains('freezr_collapsed');
    
    if (isCollapsed) {
      // Expand
      const fullHeight = getContentHeight(card);
      card.style.maxHeight = fullHeight + 'px';
      card.classList.remove('freezr_collapsed');
      card.classList.add('freezr_expanded');
      button.innerHTML = '<span>less</span> <span class="arrow">▴</span>';
      
      // Remove inline max-height after transition
      setTimeout(function() {
        card.style.maxHeight = '';
      }, 400);
    } else {
      // Collapse
      const currentHeight = card.scrollHeight;
      card.style.maxHeight = currentHeight + 'px';
      
      // Force reflow
      card.offsetHeight;
      
      card.style.maxHeight = MAX_COLLAPSED_HEIGHT + 'px';
      card.classList.add('freezr_collapsed');
      card.classList.remove('freezr_expanded');
      button.innerHTML = '<span>more</span> <span class="arrow">▾</span>';
      
      // Scroll card into view if needed
      setTimeout(function() {
        const rect = card.getBoundingClientRect();
        if (rect.top < 0) {
          card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 400);
    }
  }

  /**
   * Update card state based on current content height
   */
  function updateCardState(card) {
    if (card.classList.contains('freezr_expanded')) return;
    
    const contentHeight = getContentHeight(card);
    const expander = card.querySelector('.freezr_expander_container');
    
    if (contentHeight <= MAX_COLLAPSED_HEIGHT) {
      card.classList.remove('freezr_collapsed');
      card.classList.add('freezr_short');
      if (expander) expander.style.display = 'none';
    } else {
      card.classList.remove('freezr_short');
      if (!card.classList.contains('freezr_expanded')) {
        card.classList.add('freezr_collapsed');
      }
      if (expander) expander.style.display = '';
    }
  }

  /**
   * Set up search functionality
   */
  function setupSearch() {
    const searchInput = document.getElementById('freezr_public_search_input');
    const searchButton = document.getElementById('freezr_public_search_button');
    const clearButton = document.getElementById('freezr_public_search_clear');
    
    if (searchButton) {
      searchButton.addEventListener('click', doSearch);
    }
    
    if (searchInput) {
      searchInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          doSearch();
        }
      });
    }
    
    if (clearButton) {
      clearButton.addEventListener('click', function() {
        if (searchInput) {
          searchInput.value = '';
          searchInput.focus();
        }
      });
    }
  }

  /**
   * Execute search
   */
  function doSearch() {
    const searchInput = document.getElementById('freezr_public_search_input');
    if (!searchInput) return;
    
    const searchText = searchInput.value.trim().toLowerCase();
    const params = new URLSearchParams();
    
    // Parse special prefixes
    const parts = searchText.split(/\s+/);
    const searchTerms = [];
    
    parts.forEach(function(part) {
      if (part.startsWith('owner:')) {
        params.set('owner', part.substring(6));
      } else if (part.startsWith('user:')) {
        params.set('owner', part.substring(5));
      } else if (part.startsWith('app:')) {
        params.set('app', part.substring(4));
      } else if (part.length > 0) {
        searchTerms.push(part);
      }
    });
    
    if (searchTerms.length > 0) {
      params.set('search', searchTerms.join(' '));
    }
    
    const queryString = params.toString();
    window.location.href = '/public' + (queryString ? '?' + queryString : '');
  }

  /**
   * Handle image loading errors
   */
  function setupImageErrorHandlers() {
    document.querySelectorAll('img').forEach(function(img) {
      // Check if already failed
      if (img.naturalHeight === 0 && img.complete) {
        hideImage(img);
      }
      
      img.addEventListener('error', function() {
        hideImage(img);
      });
      
      img.addEventListener('load', function() {
        // Recheck card heights after image loads
        const card = img.closest('.freezr_public_card');
        if (card) {
          updateCardState(card);
        }
      });
    });
  }

  /**
   * Hide an image that failed to load
   */
  function hideImage(img) {
    if (img.getAttribute('data-hide-on-error') !== 'false') {
      img.style.display = 'none';
    }
  }

  /**
   * Debounce utility
   */
  function debounce(func, wait) {
    let timeout;
    return function() {
      const context = this;
      const args = arguments;
      clearTimeout(timeout);
      timeout = setTimeout(function() {
        func.apply(context, args);
      }, wait);
    };
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

