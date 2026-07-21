import type { MetadataRoute } from 'next';

// PWA manifest — Next auto-links this at /manifest.webmanifest and adds the tag.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Pivot Leads',
    short_name: 'Pivot Leads',
    description: 'Find, verify & reach decision-makers — compliant sourcing, real email verification, and AI outreach.',
    start_url: '/campaign',
    display: 'standalone',
    background_color: '#F4F5F7',
    theme_color: '#48f4ad',
    icons: [
      { src: '/icon-192.png', type: 'image/png', sizes: '192x192' },
      { src: '/icon-512.png', type: 'image/png', sizes: '512x512' },
      { src: '/icon-192-maskable.png', type: 'image/png', sizes: '192x192', purpose: 'maskable' },
      { src: '/icon-512-maskable.png', type: 'image/png', sizes: '512x512', purpose: 'maskable' },
    ],
  };
}
