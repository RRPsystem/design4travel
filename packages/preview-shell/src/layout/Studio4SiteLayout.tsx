import type { ReactNode } from 'react';
import type { BrandData } from '../components/Site/sections/types';
import { Studio4Nav } from './Studio4Nav';

interface Studio4SiteLayoutProps {
  brand: BrandData;
  transparentNav?: boolean;
  children: ReactNode;
}

export function Studio4SiteLayout({
  brand,
  transparentNav = false,
  children,
}: Studio4SiteLayoutProps) {
  return (
    <div className="relative">
      <Studio4Nav brand={brand} variant={transparentNav ? 'transparent' : 'opaque'} />
      <main>{children}</main>
    </div>
  );
}
