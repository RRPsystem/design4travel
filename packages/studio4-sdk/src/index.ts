/**
 * @design4/studio4-sdk — barrel exports.
 *
 * Publieke API voor Design4-side gebruik (validator in Edge Function of CI,
 * preview-host mount, AI-tool schema-generatie).
 */

export type {
  BrandData,
  SectionProps,
  Studio4ComponentManifest,
  SdkPolicy,
  ValidationIssue,
  ValidationResult,
} from './types.js';

export { ManifestSchema } from './manifest-schema.js';
export type { ManifestSchemaType } from './manifest-schema.js';

export { POLICY_V1_0 } from './policy-v1_0.js';

export { validatePackage } from './validator.js';
export type { PackageFiles } from './validator.js';
