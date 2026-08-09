import type { CSSProperties, ReactNode } from 'react';
import type { DesignDoc, NodeInstance } from '@design4/design-doc';
import { resolveProps } from '../resolveProps.js';
import type { RenderContext, TargetAdapter } from '../types.js';

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
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: num(props.gap, 16),
    alignItems: mapAlign(props.align as string, 'stretch'),
    justifyContent: mapJustify(props.justify as string, 'flex-start'),
    padding: num(props.padding, 0),
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
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
  };
  return <div style={style}>{children}</div>;
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
  return (
    <img
      src={src}
      alt={String(props.alt ?? '')}
      style={{
        width: (props.width as number | undefined) ?? '100%',
        height: (props.height as number | undefined) ?? 'auto',
        borderRadius: num(props.radius, 0),
        display: 'block',
        objectFit: 'cover',
      }}
    />
  );
}

function Hero({ props }: { props: Record<string, unknown> }) {
  const userTitleSize = num(props.titleFontSize, 56);
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
  };
  const inner: CSSProperties = {
    position: 'relative',
    padding: 'clamp(1rem, 4vw, 3rem)',
    textAlign: (props.align as CSSProperties['textAlign']) ?? 'center',
    maxWidth: 'min(900px, 100%)',
    width: '100%',
  };
  const overlay = (props.overlay as boolean) ?? true;
  return (
    <section style={style}>
      {overlay ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.55))',
          }}
        />
      ) : null}
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
