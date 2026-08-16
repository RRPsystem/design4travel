import { Studio4SiteLayout } from './layout/Studio4SiteLayout';
import { GeneratedComponent } from './components/GeneratedComponent';
import { MOCK_BRAND } from './mocks/brand';
import { MOCK_PAGE_CONTENT } from './mocks/pageContent';

/**
 * Preview-shell root. `scripts/build-component-archive.mjs` schrijft dit
 * bestand tijdens archive-build opnieuw met:
 *   - de correcte import (naam uit manifest.componentName)
 *   - de correcte JSX-tagnaam
 *   - eventueel transparentNav uit manifest.pageLevel.requiresTransparentNav
 * De structuur hieronder is de placeholder-vorm.
 */
export default function App() {
  return (
    <Studio4SiteLayout brand={MOCK_BRAND} transparentNav={false}>
      <GeneratedComponent
        brand={MOCK_BRAND}
        primaryColor={MOCK_BRAND.primary_color}
        secondaryColor={MOCK_BRAND.secondary_color}
        basePath="/"
        pageContent={MOCK_PAGE_CONTENT}
      />
    </Studio4SiteLayout>
  );
}
