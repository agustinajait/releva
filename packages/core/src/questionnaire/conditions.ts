import type { Condition } from './schema.js';
import type { FactValue } from '../facts.js';

/**
 * Evalúa una condición del cuestionario contra los valores conocidos.
 *
 * Semántica ante datos faltantes: una comparación sobre un campo sin valor
 * es FALSE (no se asume nada). Por eso `not` de una comparación sobre un campo
 * desconocido es TRUE; para exigir que el dato exista, combinar con `known`.
 */
export function evaluateCondition(c: Condition, values: Readonly<Record<string, FactValue | undefined>>): boolean {
  if ('all' in c) return c.all.every((x) => evaluateCondition(x, values));
  if ('any' in c) return c.any.some((x) => evaluateCondition(x, values));
  if ('not' in c) return !evaluateCondition(c.not, values);

  const v = values[c.field];
  const has = v !== undefined && v !== null;

  switch (c.op) {
    case 'known':
      return has;
    case 'unknown':
      return !has;
    case 'truthy':
      return has && (Array.isArray(v) ? v.length > 0 : Boolean(v));
  }

  if (!has) return false;
  const target = c.value;

  switch (c.op) {
    case 'eq':
      return v === target;
    case 'neq':
      return v !== target;
    case 'gt':
      return typeof v === 'number' && typeof target === 'number' && v > target;
    case 'gte':
      return typeof v === 'number' && typeof target === 'number' && v >= target;
    case 'lt':
      return typeof v === 'number' && typeof target === 'number' && v < target;
    case 'lte':
      return typeof v === 'number' && typeof target === 'number' && v <= target;
    case 'in':
      return Array.isArray(target) && target.includes(v as never);
    case 'contains':
      return Array.isArray(v) && v.includes(target as string);
  }
}
