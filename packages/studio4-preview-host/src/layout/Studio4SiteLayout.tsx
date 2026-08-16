import type { ReactNode } from 'react';
import type { BrandData } from '@design4/studio4-sdk';
import { Studio4Nav } from './Studio4Nav';

/**
 * Mock Studio4-SiteLayout. Wrapper die nav bovenaan zet en children (=
 * gemounte sectie) daaronder. Ondersteunt `transparentNav` prop, gelijk aan
 * TravelBridgeAI's SiteLayout (`src/components/Site/SiteLayout.tsx`).
 */

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
