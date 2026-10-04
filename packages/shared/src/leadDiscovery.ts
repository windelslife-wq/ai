import { z } from "zod";

/** Shared, transport-safe contracts for the standalone Lead Discovery platform. */
export const LeadStatusSchema = z.enum(["new", "contacted", "qualified", "disqualified", "converted"]);
export type LeadStatus = z.infer<typeof LeadStatusSchema>;
export const LeadStatuses = LeadStatusSchema.options;

export const ProviderStatusSchema = z.enum(["IMPLEMENTED", "TESTED", "DISABLED", "PLANNED"]);
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;
export const ProviderHealthSchema = z.object({
  name: z.string().min(1),
  status: ProviderStatusSchema,
  detail: z.string().optional(),
  checkedAt: z.string().datetime().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  lastError: z.string().optional(),
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

const IdSchema = z.string().uuid();
const NullableUrlSchema = z.string().url().max(2048).nullable();
export const LeadSchema = z.object({
  id: IdSchema,
  organizationId: IdSchema,
  source: z.string().min(1).max(50),
  sourceId: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  category: z.string().max(255).nullable(),
  address: z.string().max(2000).nullable(),
  city: z.string().max(120).nullable(),
  region: z.string().max(120).nullable(),
  country: z.string().max(120).nullable(),
  phone: z.string().max(80).nullable(),
  website: NullableUrlSchema,
  latitude: z.number().gte(-90).lte(90).nullable(),
  longitude: z.number().gte(-180).lte(180).nullable(),
  status: LeadStatusSchema,
  ownerId: IdSchema.nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Lead = z.infer<typeof LeadSchema>;

export const BusinessSearchInputSchema = z.object({
  query: z.string().trim().min(3).max(300),
  provider: z.string().trim().min(1).max(50).default("google_places"),
  limit: z.coerce.number().int().min(1).max(20).default(20),
  country: z.string().trim().max(120).optional(),
  category: z.string().trim().max(120).optional(),
});
export type BusinessSearchInput = z.input<typeof BusinessSearchInputSchema>;
export type ParsedBusinessSearchInput = z.output<typeof BusinessSearchInputSchema>;
export const BusinessSearchResultSchema = z.object({
  provider: z.string(),
  providerStatus: ProviderStatusSchema,
  results: z.array(LeadSchema),
  newLeadsCreated: z.number().int().nonnegative(),
  duplicatesDetected: z.number().int().nonnegative(),
  duplicateCandidatesCreated: z.number().int().nonnegative(),
});
export type BusinessSearchResult = z.infer<typeof BusinessSearchResultSchema>;

export const CollectionSchema = z.object({ id: IdSchema, organizationId: IdSchema, name: z.string().min(1).max(150), leadCount: z.number().int().nonnegative().default(0), createdAt: z.string().datetime(), updatedAt: z.string().datetime() });
export type Collection = z.infer<typeof CollectionSchema>;
export const CreateCollectionSchema = z.object({ name: z.string().trim().min(1).max(150) });
export const AddCollectionLeadsSchema = z.object({ leadIds: z.array(IdSchema).min(1).max(200) });

export const DuplicateRuleSchema = z.enum(["provider_source_id", "website_domain", "normalized_phone", "name_address"]);
export const DuplicateCandidateSchema = z.object({ id: IdSchema, leadAId: IdSchema, leadBId: IdSchema, leadAName: z.string().optional(), leadBName: z.string().optional(), ruleName: DuplicateRuleSchema, confidence: z.number().min(0).max(1), status: z.enum(["open", "resolved"]), createdAt: z.string().datetime() });
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;
export const ResolveDuplicateSchema = z.object({ candidateId: IdSchema, action: z.enum(["keep_a", "keep_b", "merge", "ignore"]) });
export type DuplicateResolution = z.infer<typeof ResolveDuplicateSchema>;

export const LeadNoteSchema = z.object({ id: IdSchema, leadId: IdSchema, authorId: IdSchema, body: z.string().min(1).max(4000), createdAt: z.string().datetime() });
export type LeadNote = z.infer<typeof LeadNoteSchema>;
export const AddLeadNoteSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export const ChangeLeadStatusSchema = z.object({ status: LeadStatusSchema });
export const ChangeLeadOwnerSchema = z.object({ ownerId: IdSchema.nullable() });
export const LeadActivityTypeSchema = z.enum(["LEAD_DISCOVERED", "LEAD_CREATED", "LEAD_UPDATED", "STATUS_CHANGED", "OWNER_ASSIGNED", "OWNER_REMOVED", "NOTE_ADDED", "LEAD_ADDED_TO_COLLECTION", "LEAD_REMOVED_FROM_COLLECTION", "LEAD_EXPORTED", "DUPLICATE_DETECTED", "DUPLICATE_RESOLVED"]);
export type LeadActivityType = z.infer<typeof LeadActivityTypeSchema>;
export const LeadActivitySchema = z.object({ id: IdSchema, leadId: IdSchema.nullable(), actorId: IdSchema.nullable(), type: LeadActivityTypeSchema, detail: z.record(z.unknown()), createdAt: z.string().datetime() });
export type LeadActivity = z.infer<typeof LeadActivitySchema>;

export const CoverageFieldSchema = z.object({ key: z.enum(["name", "address", "category", "phone", "website"]), field: z.string(), coverage: z.number().min(0).max(100), missing: z.number().int().nonnegative() });
export type CoverageField = z.infer<typeof CoverageFieldSchema>;
export const CoverageResponseSchema = z.object({ leadCount: z.number().int().nonnegative(), fields: z.array(CoverageFieldSchema), missingField: z.string().nullable(), missingLeads: z.array(LeadSchema) });
export type CoverageResponse = z.infer<typeof CoverageResponseSchema>;

const ExportFilterFieldsSchema = z.object({ collectionId: IdSchema.optional(), status: LeadStatusSchema.optional(), ownerId: IdSchema.optional(), country: z.string().max(120).optional(), category: z.string().max(255).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() });
export const ExportFiltersSchema = ExportFilterFieldsSchema.refine(v => !v.from || !v.to || v.from <= v.to, { message: "from must not be after to" });
export const ExportRequestSchema = ExportFilterFieldsSchema.extend({ format: z.enum(["json", "csv"]).default("json") }).refine(v => !v.from || !v.to || v.from <= v.to, { message: "from must not be after to" });
export type ExportRequest = z.input<typeof ExportRequestSchema>;
export const PipelineSummarySchema = z.object({ pipeline: z.array(z.object({ status: LeadStatusSchema, total: z.number().int().nonnegative() })) });
export type PipelineSummary = z.infer<typeof PipelineSummarySchema>;

export const SearchHistorySchema = z.object({ id: IdSchema, query: z.string(), provider: z.string(), filters: z.record(z.unknown()), resultsReturned: z.number().int().nonnegative(), newLeadsCreated: z.number().int().nonnegative(), duplicatesDetected: z.number().int().nonnegative(), errors: z.record(z.unknown()).nullable(), durationMs: z.number().int().nonnegative(), createdAt: z.string().datetime() });
export type SearchHistory = z.infer<typeof SearchHistorySchema>;

export const ProviderInfoSchema = z.object({ name: z.string(), status: ProviderStatusSchema, detail: z.string().optional(), capabilities: z.record(z.unknown()).optional() });
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;
