import type { CSSProperties, ReactNode } from 'react';
import type { DesignDoc, NodeInstance } from '@design4/design-doc';
import { resolveProps } from '../resolveProps.js';
import type { RenderContext, TargetAdapter } from '../types.js';
import { aspectRatioToCss, boxStyleToCss, maskPresetToCss } from '../style/cssMap.js';

/**
 * Scoped global rules applied inside [data-design4-root]. Kept in one place so
 * every rendered node inherits sane responsive defaults without repeating
 * inline styles at every component.
 */
export const RESPONSIVE_ROOT_CSS = `
[data-design4-root], [data-design4-root] * { box-sizing: border-box; }
[data-design4-root] { max-width: 100%; overflow-x: hidden; }
[data-design4-root] h1,
[data-design4-root] h2,
[data-design4-root] h3,
[data-design4-root] h4 {
  overflow-wrap: anywhere;
  word-break: normal;
  max-width: 100%;
  hyphens: auto;
}
[data-design4-root] p {
  overflow-wrap: anywhere;
  max-width: 100%;
}
[data-design4-root] img { max-width: 100%; height: auto; }
`;

export const webTarget: TargetAdapter = {
  output: 'web',
  renderRoot(doc, ctx) {
    const page = doc.pages[0];
    if (!page) return null;
    return (
      <div data-design4-root data-doc-id={doc.id}>
        <style data-design4-responsive>{RESPONSIVE_ROOT_CSS}</style>
        {this.renderNode(page.root, doc, ctx)}
      </div>
    );
  },
  renderNode(node, doc, ctx) {
    return renderNode(node, doc, ctx);
  },
};

function renderNode(node: NodeInstance, doc: DesignDoc, ctx: RenderContext): ReactNode {
  const def = ctx.registry.lookup(node.type);
  if (!def) {
    return <UnknownNode key={node.id} nodeId={node.id} nodeType={node.type} onSelect={ctx.onSelect} />;
  }
  const { props, error } = resolveProps(node, 'web', doc, ctx.dataModel, def);
  const selected = ctx.selectedNodeId === node.id;
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    ctx.onSelect?.({ nodeId: node.id, nodeType: node.type });
  };
  const commonWrap = (children: ReactNode) => (
    <div
      key={node.id}
      data-node-id={node.id}
      data-node-type={node.type}
      onClick={handleClick}
      style={{
        outline: selected ? '2px solid #4f46e5' : undefined,
        outlineOffset: selected ? 2 : undefined,
        borderRadius: selected ? 4 : undefined,
        cursor: 'pointer',
      }}
    >
      {error ? <RenderError message={error} /> : children}
    </div>
  );
  const children = node.children?.map((c) => renderNode(c, doc, ctx));

  switch (node.type) {
    case 'layout-row':
      return commonWrap(<LayoutRow props={props}>{children}</LayoutRow>);
    case 'layout-column':
      return commonWrap(<LayoutColumn props={props}>{children}</LayoutColumn>);
    case 'heading':
      return commonWrap(<Heading props={props} />);
    case 'text':
      return commonWrap(<Text props={props} />);
    case 'image':
      return commonWrap(<Image props={props} />);
    case 'hero':
      return commonWrap(<Hero props={props} />);
    case 'cta':
      return commonWrap(<Cta props={props} />);
    case 'section':
      return commonWrap(<Section props={props}>{children}</Section>);
    case 'button':
      return commonWrap(<Button props={props} />);
    case 'badge':
      return commonWrap(<Badge props={props} />);
    case 'divider':
      return commonWrap(<Divider props={props} />);
    case 'spacer':
      return commonWrap(<Spacer props={props} />);
    case 'shape':
      return commonWrap(<Shape props={props} />);
    default:
      return commonWrap(<UnknownNode nodeId={node.id} nodeType={node.type} onSelect={ctx.onSelect} />);
  }
}

// --- Node components (inline styles, no framework dependency) ---

function LayoutRow({
  props,
  children,
}: {
  props: Record<string, unknown>;
  children?: ReactNode;
}) {
  const box = boxStyleToCss(props.style);
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: (props.wrap as boolean | undefined) === false ? 'nowrap' : 'wrap',
    gap: num(props.gap, 16),
    alignItems: mapAlign(props.align as string, 'stretch'),
    justifyContent: mapJustify(props.justify as string, 'flex-start'),
    padding: num(props.padding, 0),
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    ...box, // BoxStyle wint van default padding wanneer beide gezet
  };
  return <div style={style}>{children}</div>;
}

function LayoutColumn({
  props,
  children,
}: {
  props: Record<string, unknown>;
  children?: ReactNode;
}) {
  const userMax = props.maxWidth as number | undefined;
  const box = boxStyleToCss(props.style);
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: num(props.gap, 24),
    alignItems: mapAlign(props.align as string, 'stretch'),
    padding: num(props.padding, 0),
    maxWidth: userMax !== undefined ? `min(${userMax}px, 100%)` : '100%',
    marginLeft: 'auto',
    marginRight: 'auto',
    width: '100%',
    minWidth: 0,
    ...box,
  };
  return <div style={style}>{children}</div>;
}

// -----------------------------------------------------------------------------
// Section — semantische container met full-bleed background + geconstrainde
// content-breedte + optional overlay.
// -----------------------------------------------------------------------------

function Section({
  props,
  children,
}: {
  props: Record<string, unknown>;
  children?: ReactNode;
}) {
  const box = boxStyleToCss(props.style);
  const paddingY = num(props.paddingY, 48);
  const paddingX = num(props.paddingX, 24);
  const gap = num(props.gap, 24);
  const maxContentWidth = num(props.maxContentWidth, 1200);
  const overlayColor = props.overlayColor as string | undefined;
  const overlayOpacity = num(props.overlayOpacity, 0);
  const hasOverlay = overlayColor && overlayOpacity > 0;

  const outer: CSSProperties = {
    position: 'relative',
    width: '100%',
    paddingTop: paddingY,
    paddingBottom: paddingY,
    paddingLeft: paddingX,
    paddingRight: paddingX,
    ...box,
  };

  const inner: CSSProperties = {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap,
    alignItems: mapAlign(props.align as string, 'stretch'),
    maxWidth: `min(${maxContentWidth}px, 100%)`,
    marginLeft: 'auto',
    marginRight: 'auto',
    width: '100%',
  };

  return (
    <section style={outer}>
      {hasOverlay ? (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', inset: 0, background: overlayColor,
            opacity: overlayOpacity, pointerEvents: 'none', zIndex: 0,
          }}
        />
      ) : null}
      <div style={inner}>{children}</div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// Button — interactieve knop of visuele label als er geen href is.
// -----------------------------------------------------------------------------

function Button({ props }: { props: Record<string, unknown> }) {
  const size = (props.size as 'xs' | 'sm' | 'md' | 'lg') ?? 'md';
  const padX = { xs: 8, sm: 12, md: 18, lg: 28 }[size];
  const padY = { xs: 4, sm: 6, md: 10, lg: 14 }[size];
  const fs = { xs: 12, sm: 13, md: 14, lg: 16 }[size];
  const variant = (props.variant as 'solid' | 'outline' | 'ghost') ?? 'solid';
  const color = (props.color as string | undefined) ?? '#111827';
  const textColor =
    (props.textColor as string | undefined) ??
    (variant === 'solid' ? '#ffffff' : color);
  const align = (props.align as 'start' | 'center' | 'end' | 'stretch') ?? 'start';
  const width = props.width;
  const fontWeight = ({ normal: 400, medium: 500, semibold: 600, bold: 700 } as const)[
    (props.fontWeight as 'normal' | 'medium' | 'semibold' | 'bold') ?? 'semibold'
  ];
  const box = boxStyleToCss(props.style);
  const href = (props.href as string | undefined)?.trim() ?? '';
  const isInteractive = href.length > 0 && href !== '#';

  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: `${padY}px ${padX}px`,
    fontSize: fs,
    fontWeight,
    background: variant === 'solid' ? color : 'transparent',
    color: textColor,
    border:
      variant === 'outline' ? `1px solid ${color}` : variant === 'ghost' ? '1px solid transparent' : 'none',
    borderRadius: 999,
    textDecoration: 'none',
    cursor: isInteractive ? 'pointer' : 'default',
    width: width === 'full' ? '100%' : typeof width === 'number' ? width : undefined,
    ...box,
  };

  const containerStyle: CSSProperties = {
    display: 'flex',
    justifyContent: mapJustify(align, 'flex-start'),
  };

  return (
    <div style={containerStyle}>
      {isInteractive ? (
        <a href={href} onClick={(e) => e.preventDefault()} style={style}>
          {String(props.text ?? '')}
        </a>
      ) : (
        // Bewust géén klikbaar element — voorkomt dat een "button" die
        // niks doet toch klikbaar oogt. Renders als span/label.
        <span role="text" style={style}>
          {String(props.text ?? '')}
        </span>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Badge — statische label.
// -----------------------------------------------------------------------------

function Badge({ props }: { props: Record<string, unknown> }) {
  const variant = (props.variant as 'solid' | 'subtle' | 'outline') ?? 'subtle';
  const size = (props.size as 'xs' | 'sm' | 'md') ?? 'sm';
  const padX = { xs: 6, sm: 8, md: 12 }[size];
  const padY = { xs: 1, sm: 2, md: 4 }[size];
  const fs = { xs: 10, sm: 11, md: 13 }[size];
  const color = (props.color as string | undefined) ?? '#4f46e5';
  const textColor =
    (props.textColor as string | undefined) ??
    (variant === 'solid' ? '#ffffff' : variant === 'subtle' ? color : color);
  const bg =
    variant === 'solid' ? color : variant === 'subtle' ? `${color}20` : 'transparent';
  const border =
    variant === 'outline' ? `1px solid ${color}` : '1px solid transparent';
  const box = boxStyleToCss(props.style);
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: `${padY}px ${padX}px`,
    fontSize: fs,
    fontWeight: 600,
    background: bg,
    color: textColor,
    border,
    borderRadius: 999,
    letterSpacing: (props.uppercase as boolean | undefined) ? 0.5 : 0,
    textTransform: (props.uppercase as boolean | undefined) ? 'uppercase' : 'none',
    ...box,
  };
  return <span style={style}>{String(props.text ?? '')}</span>;
}

// -----------------------------------------------------------------------------
// Divider — horizontale of verticale lijn.
// -----------------------------------------------------------------------------

function Divider({ props }: { props: Record<string, unknown> }) {
  const orientation =
    (props.orientation as 'horizontal' | 'vertical') ?? 'horizontal';
  const thickness = num(props.thickness, 1);
  const color = (props.color as string | undefined) ?? '#e5e7eb';
  const style = (props.style as string | undefined) ?? 'solid';
  const length = props.length as number | undefined;
  const align = (props.align as 'start' | 'center' | 'end') ?? 'start';
  const spacing = num(props.spacing, 0);

  if (orientation === 'vertical') {
    return (
      <div
        style={{
          display: 'inline-block',
          verticalAlign: 'middle',
          width: thickness,
          height: length ?? '100%',
          background: 'transparent',
          borderLeft: `${thickness}px ${style} ${color}`,
          marginLeft: spacing,
          marginRight: spacing,
        }}
      />
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: mapJustify(align, 'flex-start'),
        marginTop: spacing,
        marginBottom: spacing,
      }}
    >
      <div
        style={{
          width: length ?? '100%',
          height: 0,
          borderTop: `${thickness}px ${style} ${color}`,
        }}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Spacer — lege ruimte.
// -----------------------------------------------------------------------------

function Spacer({ props }: { props: Record<string, unknown> }) {
  const size = num(props.size, 24);
  const axis = (props.axis as 'vertical' | 'horizontal' | 'auto') ?? 'auto';
  const isHorizontal = axis === 'horizontal';
  return (
    <div
      aria-hidden="true"
      style={
        isHorizontal
          ? { display: 'inline-block', width: size, height: 1 }
          : { width: '100%', height: size }
      }
    />
  );
}

// -----------------------------------------------------------------------------
// Shape — decoratief vorm-element.
// -----------------------------------------------------------------------------

function Shape({ props }: { props: Record<string, unknown> }) {
  const variant = (props.variant as 'rectangle' | 'circle' | 'oval') ?? 'rectangle';
  const width = num(props.width, 120);
  const height = num(props.height, 120);
  const color = (props.color as string | undefined) ?? '#e5e7eb';
  const box = boxStyleToCss(props.style);

  // Variant → default borderRadius. Style.radius (indien gezet) overrules.
  let radiusStyle: CSSProperties = {};
  if (variant === 'circle') radiusStyle = { borderRadius: '50%' };
  else if (variant === 'oval') radiusStyle = { borderRadius: '50%', width, height: Math.round(height * 0.6) };

  const style: CSSProperties = {
    width,
    height,
    background: color,
    ...radiusStyle,
    ...box, // style.radius wint over variant-default als beide zijn gezet
  };
  return <div aria-hidden="true" style={style} />;
}

function Heading({ props }: { props: Record<string, unknown> }) {
  const level = (props.level as 1 | 2 | 3 | 4) ?? 2;
  const Tag = (`h${level}` as unknown) as keyof React.JSX.IntrinsicElements;
  const defaultSize = { 1: 48, 2: 32, 3: 24, 4: 20 }[level];
  const size = (props.fontSize as number | undefined) ?? defaultSize;
  const style: CSSProperties = {
    fontSize: responsiveFontSize(size, level),
    textAlign: (props.align as CSSProperties['textAlign']) ?? 'left',
    color: (props.color as string | undefined) ?? '#111827',
    margin: 0,
    fontWeight: 700,
    lineHeight: 1.1,
  };
  return <Tag style={style}>{String(props.text ?? '')}</Tag>;
}

function Text({ props }: { props: Record<string, unknown> }) {
  const style: CSSProperties = {
    fontSize: (props.fontSize as number | undefined) ?? 16,
    textAlign: (props.align as CSSProperties['textAlign']) ?? 'left',
    color: (props.color as string | undefined) ?? '#374151',
    margin: 0,
    lineHeight: 1.5,
  };
  return <p style={style}>{String(props.text ?? '')}</p>;
}

function Image({ props }: { props: Record<string, unknown> }) {
  const src = props.src as string;
  if (!src) return <ImageMissing />;
  const width = props.width as number | undefined;
  const height = props.height as number | undefined;
  const aspect = aspectRatioToCss(props.aspectRatio);
  const objectFit = (props.objectFit as string | undefined) ?? 'cover';
  const objectPosition =
    ((props.objectPosition as string | undefined) ?? 'center').replace('-', ' ');
  const mask = maskPresetToCss(props.maskPreset, width, height);
  const box = boxStyleToCss(props.style);
  const style: CSSProperties = {
    width: width ?? '100%',
    height: height ?? (aspect ? 'auto' : 'auto'),
    aspectRatio: aspect,
    display: 'block',
    objectFit: objectFit as CSSProperties['objectFit'],
    objectPosition,
    ...mask,           // maskPreset default radius
    ...box,            // style.radius / border / shadow / opacity override
  };
  return (
    <img
      src={src}
      alt={String(props.alt ?? '')}
      style={style}
    />
  );
}

function Hero({ props }: { props: Record<string, unknown> }) {
  const userTitleSize = num(props.titleFontSize, 56);
  const box = boxStyleToCss(props.style);
  const style: CSSProperties = {
    position: 'relative',
    height: num(props.height, 520),
    width: '100%',
    maxWidth: '100%',
    backgroundImage: `url(${props.imageSrc ?? ''})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    display: 'flex',
    alignItems: 'center',
    justifyContent: mapJustify((props.align as string) ?? 'center', 'center'),
    color: (props.titleColor as string) ?? '#fff',
    overflow: 'hidden',
    ...box,
  };
  const inner: CSSProperties = {
    position: 'relative',
    zIndex: 1,
    padding: 'clamp(1rem, 4vw, 3rem)',
    textAlign: (props.align as CSSProperties['textAlign']) ?? 'center',
    maxWidth: 'min(900px, 100%)',
    width: '100%',
  };
  // Overlay: expliciete overlayColor + overlayOpacity wint; legacy `overlay:true`
  // fallback default gradient (backward-compat met bestaande docs).
  const overlayColor = props.overlayColor as string | undefined;
  const overlayOpacity = props.overlayOpacity as number | undefined;
  const legacyOverlay = (props.overlay as boolean | undefined) ?? true;
  let overlayEl: ReactNode = null;
  if (overlayColor && typeof overlayOpacity === 'number' && overlayOpacity > 0) {
    overlayEl = (
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 0, background: overlayColor,
          opacity: overlayOpacity, pointerEvents: 'none',
        }}
      />
    );
  } else if (legacyOverlay && !overlayColor) {
    overlayEl = (
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.55))',
          pointerEvents: 'none',
        }}
      />
    );
  }
  return (
    <section style={style}>
      {overlayEl}
      <div style={inner}>
        <h1
          style={{
            fontSize: `clamp(2rem, 10vw, ${userTitleSize}px)`,
            fontWeight: 800,
            margin: 0,
            lineHeight: 1.1,
            color: (props.titleColor as string) ?? '#fff',
          }}
        >
          {String(props.title ?? '')}
        </h1>
        <p
          style={{
            marginTop: 16,
            fontSize: 20,
            color: (props.subtitleColor as string) ?? '#f5f5f5',
          }}
        >
          {String(props.subtitle ?? '')}
        </p>
      </div>
    </section>
  );
}

function Cta({ props }: { props: Record<string, unknown> }) {
  const size = (props.size as 'sm' | 'md' | 'lg') ?? 'md';
  const pad = { sm: '8px 14px', md: '12px 22px', lg: '16px 32px' }[size];
  const fs = { sm: 14, md: 16, lg: 18 }[size];
  const variant = (props.variant as 'primary' | 'secondary' | 'ghost') ?? 'primary';
  const bg =
    (props.color as string | undefined) ??
    (variant === 'primary' ? '#111827' : variant === 'secondary' ? '#e5e7eb' : 'transparent');
  const color =
    (props.textColor as string | undefined) ??
    (variant === 'primary' ? '#ffffff' : variant === 'secondary' ? '#111827' : '#111827');
  const align = (props.align as 'left' | 'center' | 'right') ?? 'left';
  return (
    <div style={{ display: 'flex', justifyContent: mapJustify(align, 'flex-start') }}>
      <a
        href={String(props.href ?? '#')}
        onClick={(e) => e.preventDefault()}
        style={{
          display: 'inline-block',
          padding: pad,
          fontSize: fs,
          fontWeight: 600,
          background: bg,
          color,
          borderRadius: 999,
          textDecoration: 'none',
          border: variant === 'ghost' ? '1px solid #111827' : 'none',
        }}
      >
        {String(props.text ?? '')}
      </a>
    </div>
  );
}

function UnknownNode({
  nodeId,
  nodeType,
  onSelect,
}: {
  nodeId: string;
  nodeType: string;
  onSelect?: RenderContext['onSelect'];
}) {
  return (
    <div
      data-node-id={nodeId}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.({ nodeId, nodeType });
      }}
      style={{
        padding: 12,
        background: '#fef3c7',
        color: '#92400e',
        border: '1px dashed #f59e0b',
        borderRadius: 4,
        fontSize: 12,
      }}
    >
      Onbekend node-type: <code>{nodeType}</code>
    </div>
  );
}

function ImageMissing() {
  return (
    <div
      style={{
        padding: 24,
        background: '#f3f4f6',
        color: '#6b7280',
        border: '1px dashed #d1d5db',
        borderRadius: 4,
        textAlign: 'center',
        fontSize: 12,
      }}
    >
      (Geen afbeelding geconfigureerd)
    </div>
  );
}

function RenderError({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: 8,
        background: '#fee2e2',
        color: '#991b1b',
        border: '1px solid #f87171',
        borderRadius: 4,
        fontSize: 12,
      }}
    >
      Props-validatiefout: {message}
    </div>
  );
}

// --- helpers ---

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

/**
 * Fluid font sizing: for large-ish headings (level 1 or ≥28px) return a
 * clamp() so the value shrinks on narrow viewports; smaller headings stay
 * static (no benefit and just adds visual noise in inspector).
 *
 * The user-set (or default) desktop size is preserved as the clamp upper bound
 * — on wide screens you get exactly what the user configured.
 */
export function responsiveFontSize(size: number, level?: 1 | 2 | 3 | 4): string | number {
  const shouldScale = (level ?? 2) === 1 || size >= 28;
  if (!shouldScale) return size;
  const minPx = Math.min(size, 24);
  const preferredVw = (level ?? 2) === 1 ? 8 : 6;
  return `clamp(${minPx}px, ${preferredVw}vw, ${size}px)`;
}

function mapAlign(v: string | undefined, fallback: CSSProperties['alignItems']): CSSProperties['alignItems'] {
  switch (v) {
    case 'start':
      return 'flex-start';
    case 'end':
      return 'flex-end';
    case 'center':
      return 'center';
    case 'stretch':
      return 'stretch';
    default:
      return fallback;
  }
}

function mapJustify(
  v: string | undefined,
  fallback: CSSProperties['justifyContent'],
): CSSProperties['justifyContent'] {
  switch (v) {
    case 'start':
    case 'left':
      return 'flex-start';
    case 'end':
    case 'right':
      return 'flex-end';
    case 'center':
      return 'center';
    case 'space-between':
      return 'space-between';
    default:
      return fallback;
  }
}
