import { z } from 'zod';

export const SCHEMA_VERSION = '0.1.0';

export const DocumentTypeSchema = z.enum([
  'website',
  'offerte',
  'roadbook',
  'brochure',
  'social',
  'document',
]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const OutputFormatSchema = z.enum(['web', 'pdf', 'image']);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const OutputSettingsSchema = z.object({
  enabled: z.boolean(),
});
export type OutputSettings = z.infer<typeof OutputSettingsSchema>;

export const BrandTokensSchema = z.record(z.string(), z.string());
export type BrandTokens = z.infer<typeof BrandTokensSchema>;

const NodePropsOverrideSchema = z.object({
  props: z.record(z.unknown()).optional(),
  bind: z.record(z.string()).optional(),
});
export type NodePropsOverride = z.infer<typeof NodePropsOverrideSchema>;

const NodeOverridesSchema = z.object({
  web: NodePropsOverrideSchema.optional(),
  pdf: NodePropsOverrideSchema.optional(),
  image: NodePropsOverrideSchema.optional(),
});
export type NodeOverrides = z.infer<typeof NodeOverridesSchema>;

export type NodeInstance = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  bind?: Record<string, string>;
  overrides?: NodeOverrides;
  children?: NodeInstance[];
};

export const NodeInstanceSchema: z.ZodType<NodeInstance> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    props: z.record(z.unknown()),
    bind: z.record(z.string()).optional(),
    overrides: NodeOverridesSchema.optional(),
    children: z.array(NodeInstanceSchema).optional(),
  }),
);

export const PageSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  root: NodeInstanceSchema,
});
export type Page = z.infer<typeof PageSchema>;

export const ProjectMetaSchema = z.object({
  documentType: DocumentTypeSchema,
  title: z.string(),
  brandId: z.string().optional(),
  // Pointer naar de content_sources-rij die dit ontwerp voedt (reis-URL,
  // fixture, of manual). Optioneel — een ontwerp mag zonder bron bestaan.
  // Bron van waarheid voor de content zelf blijft de content_sources-tabel;
  // dit is puur een pointer die met het document meereist (dus ook door
  // versie-rollback).
  contentSourceId: z.string().uuid().optional(),
});
export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;

export const DesignDocSchema = z.object({
  version: z.string(),
  id: z.string().min(1),
  project: ProjectMetaSchema,
  meta: z.object({
    createdAt: z.string(),
    updatedAt: z.string(),
    updatedBy: z.string().optional(),
  }),
  brandTokens: BrandTokensSchema.optional(),
  outputs: z.object({
    web: OutputSettingsSchema,
    pdf: OutputSettingsSchema.optional(),
    image: OutputSettingsSchema.optional(),
  }),
  pages: z.array(PageSchema).min(1),
});
export type DesignDoc = z.infer<typeof DesignDocSchema>;

export function isDesignDoc(value: unknown): value is DesignDoc {
  return DesignDocSchema.safeParse(value).success;
}
