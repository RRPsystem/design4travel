import { Phone } from 'lucide-react';
import type { BrandData } from '../components/types';

/**
 * Mock Studio4-nav in de preview-shell. Ondersteunt transparent+opaque
 * variant zodat hero-secties met `pageLevel.requiresTransparentNav` het
 * juiste beeld krijgen.
 */

interface Studio4NavProps {
  brand: BrandData;
  variant: 'transparent' | 'opaque';
}

export function Studio4Nav({ brand, variant }: Studio4NavProps) {
  const isTransparent = variant === 'transparent';
  return (
    <header
      className={
        'absolute top-0 left-0 right-0 z-40 flex items-center justify-between px-6 md:px-12 py-5 ' +
        (isTransparent ? 'bg-white/0' : 'bg-white/95 border-b border-gray-200')
      }
    >
      <div className="flex items-center gap-3">
        <div
          className="h-9 w-9 rounded-full grid place-items-center font-bold text-sm text-white"
          style={{ backgroundColor: brand.primary_color }}
        >
          {brand.name.slice(0, 1)}
        </div>
        <span
          className={
            'font-semibold tracking-wide ' + (isTransparent ? 'text-white' : 'text-gray-900')
          }
        >
          {brand.name}
        </span>
      </div>
      <nav
        className={
          'hidden md:flex items-center gap-8 text-sm font-medium ' +
          (isTransparent ? 'text-white/90' : 'text-gray-700')
        }
      >
        <a href="#reizen">Reizen</a>
        <a href="#bestemmingen">Bestemmingen</a>
        <a href="#over">Over ons</a>
        <a href="#contact">Contact</a>
      </nav>
      {brand.phone && (
        <a
          href={`tel:${brand.phone}`}
          className={
            'hidden md:inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm transition ' +
            (isTransparent
              ? 'border border-white/40 text-white hover:bg-white/10'
              : 'border border-gray-300 text-gray-700 hover:bg-gray-50')
          }
        >
          <Phone className="h-4 w-4" />
          {brand.phone}
        </a>
      )}
    </header>
  );
}
