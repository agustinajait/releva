import { z } from 'zod';

/**
 * Definición de cuestionario configurable desde el panel de administración.
 *
 * El administrador define QUÉ información se necesita (campos) y con qué
 * preguntas se puede obtener. RELEVA decide en tiempo de ejecución el orden
 * y cuáles hacer, según lo que el relevador ya dijo.
 */

// ── Condiciones ────────────────────────────────────────────────────────────

export const COMPARISON_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'] as const;
export const PRESENCE_OPS = ['known', 'unknown', 'truthy'] as const;

export type Condition =
  | { field: string; op: (typeof COMPARISON_OPS)[number]; value: unknown }
  | { field: string; op: (typeof PRESENCE_OPS)[number] }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ field: z.string().min(1), op: z.enum(COMPARISON_OPS), value: z.unknown() }).strict(),
    z.object({ field: z.string().min(1), op: z.enum(PRESENCE_OPS) }).strict(),
    z.object({ all: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ any: z.array(ConditionSchema).min(1) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
  ]),
) as z.ZodType<Condition>;

// ── Campos ─────────────────────────────────────────────────────────────────

export const FIELD_TYPES = ['integer', 'boolean', 'single_choice', 'multi_choice', 'text'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const KEY = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'Usar minúsculas, números y guión bajo; empezar con letra');

export const OptionSchema = z.object({
  value: KEY,
  label: z.string().min(1),
});
export type Option = z.infer<typeof OptionSchema>;

export const INDICATOR_AGGREGATES = ['sum', 'count_true', 'distribution', 'average'] as const;

export const FieldSchema = z
  .object({
    key: KEY,
    label: z.string().min(1),
    type: z.enum(FIELD_TYPES),
    category: KEY.optional(),
    description: z.string().optional(),
    options: z.array(OptionSchema).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** Obligatorio siempre (si es visible). */
    required: z.boolean().default(false),
    /** Obligatorio solo cuando se cumple la condición. */
    requiredIf: ConditionSchema.optional(),
    /** El campo solo existe cuando se cumple la condición (regla de salto). */
    visibleIf: ConditionSchema.optional(),
    /** Si el dato debe leerse en voz alta en la confirmación final. */
    confirm: z.boolean().default(true),
    /** Cómo decirlo en la confirmación. `{value}` se reemplaza. Ej: "{value} mantas". */
    spoken: z.string().optional(),
    /** Si el campo alimenta un indicador en el panel de Gobierno. */
    indicator: z
      .object({ aggregate: z.enum(INDICATOR_AGGREGATES), label: z.string().optional() })
      .optional(),
  })
  .strict();
export type Field = z.infer<typeof FieldSchema>;

// ── Preguntas ──────────────────────────────────────────────────────────────

export const QuestionSchema = z
  .object({
    key: KEY,
    /** Texto que RELEVA dice en voz alta. */
    text: z.string().min(1),
    /** Campos que esta pregunta puede completar. */
    fields: z.array(KEY).min(1),
    visibleIf: ConditionSchema.optional(),
    /**
     * Por defecto una pregunta solo se hace si cubre algún campo obligatorio
     * que falta. Con `askAlways` se hace también para campos opcionales.
     */
    askAlways: z.boolean().default(false),
    /** Preguntas a priorizar inmediatamente después de esta (seguimiento). */
    followUps: z.array(KEY).default([]),
  })
  .strict();
export type Question = z.infer<typeof QuestionSchema>;

export const CategorySchema = z.object({ key: KEY, label: z.string().min(1) }).strict();
export type Category = z.infer<typeof CategorySchema>;

// ── Cuestionario ───────────────────────────────────────────────────────────

export const QuestionnaireDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().min(1),
    /** Pregunta abierta con la que arranca cada punto. Ej: "¿Qué estás viendo?". */
    openingQuestion: KEY,
    categories: z.array(CategorySchema).default([]),
    fields: z.array(FieldSchema).min(1),
    questions: z.array(QuestionSchema).min(1),
    completion: z
      .object({
        /** Condición adicional (además de tener todos los obligatorios). */
        condition: ConditionSchema.optional(),
        /** Si se pide confirmación verbal antes de guardar. */
        requireConfirmation: z.boolean().default(true),
      })
      .strict()
      .default({ requireConfirmation: true }),
  })
  .strict()
  .superRefine((def, ctx) => {
    for (const issue of crossReferenceIssues(def)) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
  });

export type QuestionnaireDefinition = z.infer<typeof QuestionnaireDefinitionSchema>;
export type QuestionnaireDefinitionInput = z.input<typeof QuestionnaireDefinitionSchema>;

export interface DefinitionIssue {
  path: (string | number)[];
  message: string;
}

function conditionFields(c: Condition): string[] {
  if ('all' in c) return c.all.flatMap(conditionFields);
  if ('any' in c) return c.any.flatMap(conditionFields);
  if ('not' in c) return conditionFields(c.not);
  return [c.field];
}

/** Validaciones entre partes del cuestionario que Zod no puede expresar por sí solo. */
function crossReferenceIssues(def: {
  openingQuestion: string;
  categories: { key: string }[];
  fields: z.input<typeof FieldSchema>[];
  questions: z.input<typeof QuestionSchema>[];
  completion?: { condition?: Condition };
}): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const fieldKeys = new Set<string>();
  const questionKeys = new Set<string>();
  const categoryKeys = new Set(def.categories.map((c) => c.key));

  def.fields.forEach((f, i) => {
    if (fieldKeys.has(f.key)) issues.push({ path: ['fields', i, 'key'], message: `Campo duplicado: ${f.key}` });
    fieldKeys.add(f.key);
    const isChoice = f.type === 'single_choice' || f.type === 'multi_choice';
    if (isChoice && (!f.options || f.options.length === 0)) {
      issues.push({ path: ['fields', i, 'options'], message: `El campo ${f.key} necesita opciones` });
    }
    if (!isChoice && f.options) {
      issues.push({ path: ['fields', i, 'options'], message: `El campo ${f.key} no es de opciones` });
    }
    if (f.options) {
      const seen = new Set<string>();
      for (const o of f.options) {
        if (seen.has(o.value)) issues.push({ path: ['fields', i, 'options'], message: `Opción duplicada: ${o.value}` });
        seen.add(o.value);
      }
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
      issues.push({ path: ['fields', i], message: `En ${f.key}, min es mayor que max` });
    }
    if (f.category && !categoryKeys.has(f.category)) {
      issues.push({ path: ['fields', i, 'category'], message: `Categoría inexistente: ${f.category}` });
    }
  });

  def.questions.forEach((q, i) => {
    if (questionKeys.has(q.key)) issues.push({ path: ['questions', i, 'key'], message: `Pregunta duplicada: ${q.key}` });
    questionKeys.add(q.key);
    q.fields.forEach((fk, j) => {
      if (!fieldKeys.has(fk)) issues.push({ path: ['questions', i, 'fields', j], message: `Campo inexistente: ${fk}` });
    });
  });

  def.questions.forEach((q, i) => {
    (q.followUps ?? []).forEach((fu, j) => {
      if (!questionKeys.has(fu)) issues.push({ path: ['questions', i, 'followUps', j], message: `Pregunta inexistente: ${fu}` });
      if (fu === q.key) issues.push({ path: ['questions', i, 'followUps', j], message: 'Una pregunta no puede seguirse a sí misma' });
    });
    if (q.visibleIf) checkCondition(q.visibleIf as Condition, ['questions', i, 'visibleIf']);
  });

  def.fields.forEach((f, i) => {
    if (f.visibleIf) checkCondition(f.visibleIf as Condition, ['fields', i, 'visibleIf']);
    if (f.requiredIf) checkCondition(f.requiredIf as Condition, ['fields', i, 'requiredIf']);
    if (f.visibleIf && conditionFields(f.visibleIf as Condition).includes(f.key)) {
      issues.push({ path: ['fields', i, 'visibleIf'], message: `${f.key} no puede depender de sí mismo` });
    }
  });

  if (def.completion?.condition) checkCondition(def.completion.condition as Condition, ['completion', 'condition']);

  if (!questionKeys.has(def.openingQuestion)) {
    issues.push({ path: ['openingQuestion'], message: `Pregunta de apertura inexistente: ${def.openingQuestion}` });
  }

  // Todo campo obligatorio debe poder preguntarse; si no, un punto nunca se completaría.
  const askable = new Set(def.questions.flatMap((q) => q.fields));
  def.fields.forEach((f, i) => {
    if ((f.required || f.requiredIf) && !askable.has(f.key)) {
      issues.push({ path: ['fields', i], message: `El campo obligatorio ${f.key} no está en ninguna pregunta` });
    }
  });

  return issues;

  function checkCondition(c: Condition, path: (string | number)[]) {
    for (const fk of conditionFields(c)) {
      if (!fieldKeys.has(fk)) issues.push({ path, message: `La condición usa un campo inexistente: ${fk}` });
    }
  }
}

export type ParseResult =
  | { ok: true; definition: QuestionnaireDefinition }
  | { ok: false; issues: DefinitionIssue[] };

/** Valida un cuestionario (p. ej. antes de publicarlo). Nunca lanza. */
export function parseQuestionnaire(input: unknown): ParseResult {
  const r = QuestionnaireDefinitionSchema.safeParse(input);
  if (r.success) return { ok: true, definition: r.data };
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({ path: i.path as (string | number)[], message: i.message })),
  };
}
