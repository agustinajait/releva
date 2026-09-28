/**
 * Roles y permisos. Declarados una sola vez y aplicados por la API.
 * La web y la app los usan solo para mostrar u ocultar opciones; la
 * autorización real ocurre siempre en el servidor (y en la base, vía RLS).
 */

export const ROLES = ['super_admin', 'client_admin', 'analyst', 'surveyor'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  client_admin: 'Administrador de cliente',
  analyst: 'Analista (Gobierno)',
  surveyor: 'Relevador',
};

export const PERMISSIONS = [
  'clients:manage',
  'organizations:manage',
  'users:manage',
  'projects:manage',
  'projects:read',
  'zones:manage',
  'routes:manage',
  'routes:operate',
  'questionnaires:manage',
  'questionnaires:read',
  'surveys:create',
  'surveys:read',
  'points:read',
  'indicators:read',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  super_admin: ALL,
  client_admin: new Set<Permission>([
    'organizations:manage',
    'users:manage',
    'projects:manage',
    'projects:read',
    'zones:manage',
    'routes:manage',
    'questionnaires:manage',
    'questionnaires:read',
    'surveys:read',
    'points:read',
    'indicators:read',
    'audit:read',
  ]),
  analyst: new Set<Permission>([
    'projects:read',
    'questionnaires:read',
    'surveys:read',
    'points:read',
    'indicators:read',
  ]),
  surveyor: new Set<Permission>([
    'projects:read',
    'questionnaires:read',
    'routes:operate',
    'surveys:create',
  ]),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsOf(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** Qué roles puede asignar un usuario al crear otros usuarios. */
export function assignableRoles(role: Role): Role[] {
  if (role === 'super_admin') return [...ROLES];
  if (role === 'client_admin') return ['client_admin', 'analyst', 'surveyor'];
  return [];
}
