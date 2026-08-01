/* =============================================================================
 * TCM BrewOps — shared Tailwind theme
 * -----------------------------------------------------------------------------
 * Load AFTER the Tailwind CDN script and BEFORE any markup that uses the tokens.
 *
 * This used to be duplicated in every page, and the copies had drifted:
 * staff.html was missing vintageGreen, victorianLight, paperDark, brandLightBrown,
 * dangerLight and the `elegant` shadow, so a dozen classes on that page — the
 * dashboard card borders, the log-out link, the metric icon chips — silently
 * rendered as nothing. One definition means the terminals cannot drift again.
 * ========================================================================== */
window.tailwind = window.tailwind || {};
window.tailwind.config = {
  theme: {
    extend: {
      colors: {
        paper: '#FAF8F5',
        paperDark: '#e8dfd1',
        victorian: '#132A1B',
        victorianLight: '#23452F',
        antique: '#D4AF37',
        antiqueLight: '#F2DF96',
        danger: '#8B2626',
        dangerLight: '#FCE8E8',
        brandBrown: '#8b5e3c',
        brandLightBrown: '#c08a5b',
        vintageGreen: '#4A5D23'
      },
      fontFamily: {
        serif: ['"Playfair Display"', 'serif'],
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
        poppins: ['"Poppins"', 'sans-serif']
      },
      boxShadow: {
        elegant: '0 8px 32px -4px rgba(19, 42, 27, 0.1)',
        login: '0 15px 40px rgba(0,0,0,0.1)',
        vintage: '0 10px 30px rgba(44, 26, 15, 0.08)',
        'inner-vintage': 'inset 0 2px 10px rgba(44, 26, 15, 0.05)'
      },
      backgroundImage: {
        // staff.html and owner.html both referenced `bg-leaf-pattern`, but no
        // page ever defined it, so the workbench watermark never appeared.
        'leaf-pattern': "url('assets/leaf-pattern.png')"
      },
      keyframes: {
        'alert-flash': {
          '0%, 100%': { boxShadow: '0 8px 32px -4px rgba(19, 42, 27, 0.1)' },
          '50%': { boxShadow: '0 0 0 3px rgba(212, 175, 55, 0.45)' }
        }
      },
      animation: {
        // Referenced by the staff "Incoming Deliveries" panel, never defined.
        'alert-flash': 'alert-flash 2.4s ease-in-out infinite'
      }
    }
  }
};
