import { z } from 'zod';
import { FACT_SOURCES, FACT_STATUSES } from './facts.js';

/**
 * Contrato de sincronización entre la app (offline) y la API.
 * `clientUuid` lo genera el celular: el servidor es idempotente por ese valor,
 * así un reenvío nunca duplica un relevamiento.
 */

const iso = z.string().datetime({ offset: true });

export const SyncLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative(),
  altitude: z.number().nullable().optional(),
  capturedAt: iso,
});

export const SyncFactSchema = z.object({
  fieldKey: z.string().min(1).max(63),
  value: z.union([z.number(), z.boolean(), z.string().max(2000), z.array(z.string()), z.null()]),
  status: z.enum(FACT_STATUSES),
  source: z.enum(FACT_SOURCES),
  questionKey: z.string().max(63).optional(),
  rawAnswer: z.string().max(4000).optional(),
  recordedAt: iso,
});

export const SyncUtteranceSchema = z.object({
  speaker: z.enum(['releva', 'surveyor']),
  text: z.string().max(4000),
  at: iso,
});

export const SurveySyncItemSchema = z.object({
  clientUuid: z.string().uuid(),
  projectId: z.string().uuid(),
  routeId: z.string().uuid().nullable().optional(),
  questionnaireVersionId: z.string().uuid(),
  location: SyncLocationSchema,
  status: z.enum(['completed', 'incomplete', 'discarded']),
  startedAt: iso,
  completedAt: iso.nullable().optional(),
  facts: z.array(SyncFactSchema).max(500),
  utterances: z.array(SyncUtteranceSchema).max(1000).default([]),
});
export type SurveySyncItem = z.infer<typeof SurveySyncItemSchema>;

export const SyncRequestSchema = z.object({
  items: z.array(SurveySyncItemSchema).min(1).max(50),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export type SyncItemResult =
  | { clientUuid: string; status: 'accepted'; surveyId: string; pointId: string; matchedExistingPoint: boolean }
  | { clientUuid: string; status: 'duplicate'; surveyId: string; pointId: string }
  | { clientUuid: string; status: 'rejected'; error: string };

export interface SyncResponse {
  results: SyncItemResult[];
}
