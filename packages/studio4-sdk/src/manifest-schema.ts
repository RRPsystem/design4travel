import { z } from 'zod';

/**
 * Zod-schema voor `manifest.json` van een Design4-gegenereerd Studio4-
 * component-pakket. Reflectie van `Studio4ComponentManifest` in `./types.ts`
 * met validatie-regels (min/max, regex-conventies, etc.).
 */

const KEBAB = /^[a-z][a-z0-9-]*$/;
const SNAKE = /^[a-z][a-z0-9_]*$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;

const ProducedBySchema = z.object({
  engine: z.enum(['studio4-component', 'pdf-template']),
  iteration: z.number().int().min(1).max(10),
  parentCallId: z.string().min(1),
  sourceReferenceId: z.string().min(1),
});

const MediaEntrySchema = z.object({
  role: z.string().min(1).max(40),
  kind: z.enum(['image', 'video']),
  minWidth: z.number().int().min(1).max(8000).optional(),
  cutout: z.boolean().optional(),
  optional: z.boolean().optional(),
  domainsRequested: z.array(z.string()).optional(),
});

const PageLevelSchema = z.object({
  requiresTransparentNav: z.boolean().optional(),
  recommendedPage: z.string().optional(),
  reviewerNote: z.string().max(500).optional(),
});

const ResponsiveSchema = z.object({
  breakpoints: z
    .array(z.enum(['sm', 'md', 'lg', 'xl', '2xl']))
    .min(1)
    .max(5),
  mobileStrategy: z.string().max(80).optional(),
});

const A11ySchema = z.object({
  landmarks: z.array(z.string()).optional(),
  supportsReducedMotion: z.boolean().optional(),
});

const ConsumesSchema = z.object({
  brand: z.array(z.string()).max(30).optional(),
  primaryColor: z.boolean().optional(),
  secondaryColor: z.boolean().optional(),
  pageContent: z.array(z.string()).max(30).optional(),
  sectionStyle: z.boolean().optional(),
});

/**
 * Volledig manifest-schema. Validator (`./validator.ts`) roept
 * `ManifestSchema.safeParse(json)` aan als eerste gate; daarna komen de
 * server-side policy-checks (import-whitelist, AST-scans, image-domains, ...).
 */
export const ManifestSchema = z
  .object({
    sdkVersion: z.literal('1.0'),
    id: z.string().regex(KEBAB, 'id moet kebab-case zijn').min(3).max(60),
    displayName: z.string().min(1).max(80),
    componentName: z
      .string()
      .regex(PASCAL, 'componentName moet PascalCase zijn')
      .min(3)
      .max(60),
    fileName: z
      .string()
      .regex(/^[A-Z][A-Za-z0-9]*\.tsx$/, 'fileName moet PascalCase eindigend op .tsx zijn'),
    registryKey: z
      .string()
      .regex(SNAKE, 'registryKey moet snake_case zijn')
      .min(3)
      .max(60),
    category: z.string().min(1).max(40),
    producedBy: ProducedBySchema,
    requestedImports: z.array(z.string()).min(1).max(20),
    consumes: ConsumesSchema,
    media: z.array(MediaEntrySchema).max(8).optional(),
    pageLevel: PageLevelSchema.optional(),
    responsive: ResponsiveSchema.optional(),
    a11y: A11ySchema.optional(),
  })
  .strict()
  .refine(
    (m) => m.fileName === `${m.componentName}.tsx`,
    { message: 'fileName moet exact "componentName + .tsx" zijn', path: ['fileName'] },
  );

export type ManifestSchemaType = z.infer<typeof ManifestSchema>;
