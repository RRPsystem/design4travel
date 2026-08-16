import { useState } from 'react';
import { Studio4SiteLayout } from './layout/Studio4SiteLayout';
import { HelloSection } from './sections/HelloSection';
import { MOCK_BRAND } from './mocks/brand';
import { MOCK_PAGE_CONTENT } from './mocks/pageContent';

/**
 * Preview-host app. Toont een top-bar met viewport/nav-toggles en daaronder
 * de Studio4-mock-SiteLayout waarin de gemounte sectie leeft.
 *
 * Iteratie 1: HelloSection hardcoded gemount. Iteratie 2 kan hier dynamische
 * loading toevoegen van een gegenereerd Studio4-component-pakket uit Storage.
 */

type Viewport = 'desktop' | 'mobile';

const VIEWPORTS: Record<Viewport, { label: string; width: number }> = {
  desktop: { label: 'Desktop 1440', width: 1440 },
  mobile: { label: 'Mobile 390', width: 390 },
};

export default function App() {
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [transparentNav, setTransparentNav] = useState(false);

  const vp = VIEWPORTS[viewport];

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Preview-host chrome */}
      <div className="preview-chrome flex items-center justify-between px-6 py-3">
        <div className="text-sm font-semibold tracking-wide">
          Studio4 Preview Host <span className="text-gray-500">— Design4</span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-gray-400">Viewport:</span>
            {(Object.keys(VIEWPORTS) as Viewport[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setViewport(k)}
                className={
                  'rounded px-2 py-1 ' +
                  (viewport === k ? 'bg-white text-gray-900' : 'bg-gray-800 text-gray-300')
                }
              >
                {VIEWPORTS[k].label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={transparentNav}
              onChange={(e) => setTransparentNav(e.target.checked)}
            />
            <span className="text-gray-300">transparentNav</span>
          </label>
        </div>
      </div>

      {/* Gemounte sectie in fixed-viewport-frame */}
      <div className="flex justify-center py-6">
        <div
          className="bg-white shadow-2xl overflow-hidden"
          style={{ width: `${vp.width}px`, maxWidth: '100%' }}
        >
          <Studio4SiteLayout brand={MOCK_BRAND} transparentNav={transparentNav}>
            <HelloSection
              brand={MOCK_BRAND}
              primaryColor={MOCK_BRAND.primary_color}
              secondaryColor={MOCK_BRAND.secondary_color}
              basePath="/"
              pageContent={MOCK_PAGE_CONTENT}
            />
          </Studio4SiteLayout>
        </div>
      </div>
    </div>
  );
}
