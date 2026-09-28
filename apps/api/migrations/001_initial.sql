-- RELEVA · Migración 001 · Esquema inicial
--
-- Principios:
--  * Toda tabla con datos de un cliente tiene client_id.
--  * Las relaciones entre tablas incluyen client_id (FK compuestas): es imposible,
--    a nivel de base, asociar un punto de un cliente a un proyecto de otro.
--  * Row Level Security FORZADO: aunque el código tenga un error, la base no
--    devuelve filas de otro cliente. La API setea app.client_id / app.is_super
--    al inicio de cada transacción.
--  * Sin datos biométricos ni identificación de personas: la unidad es el punto.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE EXCEPTION 'Falta la extensión PostGIS. Crearla como superusuario: CREATE EXTENSION postgis;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    RAISE EXCEPTION 'Falta la extensión pgcrypto. Crearla como superusuario: CREATE EXTENSION pgcrypto;';
  END IF;
END $$;

-- ── Contexto de tenant ─────────────────────────────────────────────────────

CREATE FUNCTION app_is_super() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.is_super', true), '') = 'true'
$$;

CREATE FUNCTION app_client_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.client_id', true), '')::uuid
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ── Clientes y organismos ──────────────────────────────────────────────────

CREATE TABLE clients (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (client_id, name)
);

-- ── Usuarios ───────────────────────────────────────────────────────────────

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid REFERENCES clients(id) ON DELETE CASCADE,
  organization_id  uuid,
  email            text NOT NULL CHECK (email = lower(email) AND position('@' in email) > 1),
  name             text NOT NULL,
  password_hash    text NOT NULL,
  role             text NOT NULL CHECK (role IN ('super_admin', 'client_admin', 'analyst', 'surveyor')),
  active           boolean NOT NULL DEFAULT true,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Un super admin no pertenece a ningún cliente; cualquier otro rol sí.
  CHECK ((role = 'super_admin') = (client_id IS NULL)),
  UNIQUE (email),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, organization_id) REFERENCES organizations(client_id, id)
);

CREATE TABLE refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid REFERENCES refresh_tokens(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);

-- ── Proyectos ──────────────────────────────────────────────────────────────

CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  organization_id  uuid,
  name             text NOT NULL CHECK (length(trim(name)) > 0),
  description      text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  -- Radio en metros para considerar que una captura corresponde a un punto existente.
  dedupe_radius_m  integer NOT NULL DEFAULT 25 CHECK (dedupe_radius_m BETWEEN 1 AND 500),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, organization_id) REFERENCES organizations(client_id, id)
);
CREATE TRIGGER projects_updated BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE project_members (
  client_id   uuid NOT NULL,
  project_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (client_id, project_id) REFERENCES projects(client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, user_id) REFERENCES users(client_id, id) ON DELETE CASCADE
);

-- ── Zonas y recorridos ─────────────────────────────────────────────────────

CREATE TABLE zones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL,
  project_id  uuid NOT NULL,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  code        text,
  color       text CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  geom        geometry(MultiPolygon, 4326) NOT NULL CHECK (ST_IsValid(geom)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (project_id, name),
  FOREIGN KEY (client_id, project_id) REFERENCES projects(client_id, id) ON DELETE CASCADE
);
CREATE INDEX zones_geom_idx ON zones USING gist (geom);
CREATE TRIGGER zones_updated BEFORE UPDATE ON zones FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE routes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL,
  project_id    uuid NOT NULL,
  zone_id       uuid,
  name          text NOT NULL CHECK (length(trim(name)) > 0),
  surveyor_id   uuid,
  status        text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'finished')),
  planned_path  geometry(LineString, 4326),
  track         geometry(LineString, 4326),
  started_at    timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, project_id) REFERENCES projects(client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, zone_id) REFERENCES zones(client_id, id),
  FOREIGN KEY (client_id, surveyor_id) REFERENCES users(client_id, id),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX routes_project_idx ON routes(project_id);
CREATE TRIGGER routes_updated BEFORE UPDATE ON routes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Cuestionarios (versionados; publicado = inmutable) ─────────────────────

CREATE TABLE questionnaires (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL,
  project_id  uuid NOT NULL,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, project_id) REFERENCES projects(client_id, id) ON DELETE CASCADE
);

CREATE TABLE questionnaire_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL,
  questionnaire_id  uuid NOT NULL,
  version           integer NOT NULL CHECK (version > 0),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  definition        jsonb NOT NULL,
  published_at      timestamptz,
  published_by      uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (questionnaire_id, version),
  FOREIGN KEY (client_id, questionnaire_id) REFERENCES questionnaires(client_id, id) ON DELETE CASCADE
);
-- Solo una versión publicada por cuestionario.
CREATE UNIQUE INDEX questionnaire_one_published ON questionnaire_versions(questionnaire_id) WHERE status = 'published';

CREATE FUNCTION questionnaire_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.definition IS DISTINCT FROM OLD.definition THEN
    RAISE EXCEPTION 'Una versión publicada no puede modificarse; crear una versión nueva'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'Una versión retirada no puede reactivarse' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER questionnaire_versions_immutable BEFORE UPDATE ON questionnaire_versions
  FOR EACH ROW EXECUTE FUNCTION questionnaire_versions_guard();

-- ── Puntos y relevamientos ─────────────────────────────────────────────────

-- Un punto es un LUGAR. Cada visita a ese lugar es un relevamiento (survey):
-- así el punto conserva su historial.
CREATE TABLE points (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL,
  project_id     uuid NOT NULL,
  zone_id        uuid,
  location       geography(Point, 4326) NOT NULL,
  accuracy_m     real CHECK (accuracy_m >= 0),
  first_seen_at  timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL,
  survey_count   integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, project_id) REFERENCES projects(client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, zone_id) REFERENCES zones(client_id, id) ON DELETE SET NULL (zone_id)
);
CREATE INDEX points_location_idx ON points USING gist (location);
CREATE INDEX points_project_idx ON points(project_id, last_seen_at DESC);

-- La zona de un punto se calcula en la base a partir de la geometría.
CREATE FUNCTION points_assign_zone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.location IS DISTINCT FROM OLD.location THEN
    SELECT z.id INTO NEW.zone_id
      FROM zones z
     WHERE z.project_id = NEW.project_id
       AND ST_Covers(z.geom, NEW.location::geometry)
     ORDER BY ST_Area(z.geom) ASC
     LIMIT 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER points_zone BEFORE INSERT OR UPDATE ON points FOR EACH ROW EXECUTE FUNCTION points_assign_zone();

CREATE TABLE surveys (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                  uuid NOT NULL,
  project_id                 uuid NOT NULL,
  point_id                   uuid NOT NULL,
  route_id                   uuid,
  questionnaire_version_id   uuid NOT NULL,
  surveyor_id                uuid,
  -- Generado por el celular: garantiza que un reenvío offline no duplique.
  client_uuid                uuid NOT NULL,
  status                     text NOT NULL CHECK (status IN ('completed', 'incomplete', 'discarded')),
  location                   geography(Point, 4326) NOT NULL,
  accuracy_m                 real CHECK (accuracy_m >= 0),
  altitude_m                 real,
  captured_at                timestamptz NOT NULL,
  started_at                 timestamptz NOT NULL,
  completed_at               timestamptz,
  received_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  -- Único por cliente (no global): un cliente no puede detectar ni bloquear UUIDs de otro.
  UNIQUE (client_id, client_uuid),
  FOREIGN KEY (client_id, project_id) REFERENCES projects(client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, point_id) REFERENCES points(client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, route_id) REFERENCES routes(client_id, id),
  FOREIGN KEY (client_id, questionnaire_version_id) REFERENCES questionnaire_versions(client_id, id),
  FOREIGN KEY (client_id, surveyor_id) REFERENCES users(client_id, id)
);
CREATE INDEX surveys_point_idx ON surveys(point_id, captured_at DESC);
CREATE INDEX surveys_project_idx ON surveys(project_id, captured_at DESC);

CREATE TABLE survey_facts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id     uuid NOT NULL,
  survey_id     uuid NOT NULL,
  field_key     text NOT NULL,
  value         jsonb,
  status        text NOT NULL CHECK (status IN ('mentioned', 'extracted', 'confirmed', 'unknown')),
  source        text NOT NULL CHECK (source IN ('voice', 'manual', 'system')),
  question_key  text,
  raw_answer    text,
  recorded_at   timestamptz NOT NULL,
  UNIQUE (survey_id, field_key),
  FOREIGN KEY (client_id, survey_id) REFERENCES surveys(client_id, id) ON DELETE CASCADE,
  -- Un dato desconocido nunca tiene valor: no se inventa.
  CHECK ((status = 'unknown') = (value IS NULL OR value = 'null'::jsonb))
);
CREATE INDEX survey_facts_field_idx ON survey_facts(field_key);

-- Transcripción de la conversación: respaldo y auditoría.
CREATE TABLE survey_utterances (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id   uuid NOT NULL,
  survey_id   uuid NOT NULL,
  seq         integer NOT NULL,
  speaker     text NOT NULL CHECK (speaker IN ('releva', 'surveyor')),
  text        text NOT NULL,
  at          timestamptz NOT NULL,
  UNIQUE (survey_id, seq),
  FOREIGN KEY (client_id, survey_id) REFERENCES surveys(client_id, id) ON DELETE CASCADE
);

-- ── Auditoría (solo inserción) ─────────────────────────────────────────────

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id   uuid REFERENCES clients(id) ON DELETE SET NULL,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role  text,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          inet,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_client_idx ON audit_log(client_id, at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log(entity, entity_id);

CREATE FUNCTION audit_log_readonly() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La auditoría es de solo inserción' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_readonly();

-- ── Row Level Security ─────────────────────────────────────────────────────

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON clients USING (app_is_super() OR id = app_client_id())
  WITH CHECK (app_is_super());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations', 'users', 'projects', 'project_members', 'zones', 'routes',
    'questionnaires', 'questionnaire_versions', 'points', 'surveys',
    'survey_facts', 'survey_utterances'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant ON %I USING (app_is_super() OR client_id = app_client_id()) '
      'WITH CHECK (app_is_super() OR client_id = app_client_id())', t);
  END LOOP;
END $$;

-- Auditoría: cada cliente lee la suya; se puede insertar para el propio cliente.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT USING (app_is_super() OR client_id = app_client_id());
CREATE POLICY audit_insert ON audit_log FOR INSERT
  WITH CHECK (app_is_super() OR client_id = app_client_id());
