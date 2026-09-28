# RELEVA — Arquitectura técnica (Etapa 1)

RELEVA es un **asistente operativo de relevamiento territorial**: una app Android que conduce
por voz la entrevista del relevador, más un sistema web para administrar y visualizar lo relevado.

No es un chatbot. Es la combinación de cinco piezas con responsabilidades separadas:

```
IA conversacional  →  interpreta lenguaje natural y propone datos (nunca decide sola)
Motor de cuestionarios →  define QUÉ información se necesita (configurado desde Admin)
Reglas de negocio  →  condiciones, saltos, obligatorios, criterio de "punto completo"
Máquina de estados →  CUÁNDO puede pasar cada cosa (p. ej. nunca con el vehículo en movimiento)
Datos estructurados →  cada dato con valor, origen, respuesta original y estado de confirmación
```

## 1. Vista general

```
┌──────────────────────────┐        ┌───────────────────────────┐
│  App móvil (Expo / RN)   │        │  Panel web (React + Vite) │
│  - máquina de estados    │        │  - Super Admin            │
│  - GPS + detección mov.  │        │  - Panel Gobierno (mapa,  │
│  - voz (STT/TTS adapt.)  │        │    indicadores, fichas)   │
│  - cola offline (SQLite) │        └─────────────┬─────────────┘
└────────────┬─────────────┘                      │ HTTPS + JWT
             │ HTTPS + JWT (sync idempotente)     │
             ▼                                    ▼
      ┌──────────────────────────────────────────────────┐
      │ API (Node + Fastify + TypeScript)                │
      │ auth · roles · tenancy · proyectos · zonas ·     │
      │ recorridos · puntos · cuestionarios · sync ·     │
      │ indicadores · auditoría                          │
      └───────────────────────┬──────────────────────────┘
                              │ SQL (rol releva_app, RLS forzado)
                              ▼
      ┌──────────────────────────────────────────────────┐
      │ PostgreSQL 16 + PostGIS 3                        │
      └──────────────────────────────────────────────────┘

          @releva/core (TypeScript puro, sin dependencias de plataforma)
          compartido por app, API y web: tipos, esquema de cuestionario,
          evaluador de reglas, máquina de estados, cola offline,
          interfaces de voz e intérprete.
```

## 2. Monorepo

| Carpeta          | Qué es                                                                 |
|------------------|------------------------------------------------------------------------|
| `packages/core`  | Dominio compartido. Se testea sin base de datos ni dispositivo.         |
| `apps/api`       | Backend HTTP, migraciones SQL, pruebas de integración contra PostGIS.   |
| `apps/web`       | Panel web responsive: Super Admin y Gobierno en la misma app, por rol. |
| `apps/mobile`    | App Android (Expo / React Native).                                      |
| `infra`          | `docker-compose` con PostGIS para desarrollo.                           |

Workspaces de npm. Un solo `npm install` en la raíz.

## 3. Decisiones técnicas y por qué

**TypeScript en todas las capas.** El esquema de cuestionario, las reglas y la máquina de estados
se escriben una vez en `@releva/core` y se usan igual en el celular (offline), en la API
(validación al publicar y al sincronizar) y en la web (editor y previsualización).
Si una regla se evaluara distinto en el celular y en el servidor, los datos no serían confiables.

**Expo / React Native para Android.** Permite reutilizar `@releva/core` tal cual, tiene módulos
maduros de GPS, SQLite y TTS, y genera APK/AAB con EAS Build. Deja abierta la puerta a iOS sin
reescribir.

**Fastify.** Rápido, validación por esquema, tipado. El código de dominio no depende de Fastify:
las rutas son finas y llaman a servicios.

**PostgreSQL + PostGIS.** Zonas como `MultiPolygon`, puntos como `geography(Point)`, recorridos
como `LineString`. La zona de un punto se calcula en la base (`ST_Covers`), y la deduplicación
de puntos usa `ST_DWithin` con índice GiST.

**Separación entre clientes con Row Level Security forzado.** Cada tabla de datos de un cliente
tiene `client_id`. La API se conecta con el rol `releva_app` (no superusuario) y cada request
corre en una transacción con `SET LOCAL app.client_id` / `app.is_super`. Aunque un endpoint
tuviera un bug, la base no devuelve filas de otro cliente. Además, los servicios filtran por
cliente: son dos barreras independientes.

**Cuestionarios como datos, no como código.** Un cuestionario es un documento JSON versionado,
validado con Zod (`QuestionnaireDefinition`). Al publicarse queda inmutable; cada relevamiento
guarda la versión exacta con la que se hizo. Contiene: campos (tipo, obligatorio, opciones,
si requiere confirmación), preguntas (texto hablado, qué campos cubre, preguntas de seguimiento),
condiciones (`visibleIf`, `requiredIf`) y el criterio de completitud.

**El administrador define QUÉ; RELEVA decide CÓMO.** El núcleo calcula, a partir de los datos ya
conocidos, qué campos siguen faltando y cuál es la próxima pregunta que cubre más faltantes.
Si el relevador dijo "una mujer con un chico y tres bolsos", esos campos quedan cubiertos y no
se vuelven a preguntar.

**La IA propone, las reglas disponen.** El intérprete (`Interpreter`) recibe la respuesta y el
cuestionario, y devuelve *propuestas* de datos con la frase de origen. El núcleo las valida contra
el tipo y las opciones del campo; lo que no valida se descarta. Un dato nunca pasa a `confirmed`
sin la confirmación del relevador. Nada se completa por inferencia: lo no dicho queda `unknown`.

**Proveedores de voz e IA desacoplados.** Interfaces `SpeechToText`, `TextToSpeech` e
`Interpreter` en el núcleo. En esta etapa:
- TTS: voz del dispositivo (`expo-speech`).
- STT: la respuesta se escribe en pantalla (modo desarrollo) y entra por el mismo camino que
  entrará la transcripción real.
- Intérprete: `DirectAnswerInterpreter`, sin IA. Entiende respuestas directas (sí/no, "no sé",
  números, opciones nombradas y "sí, una mochila"). Es deliberadamente conservador: si no
  entiende, no propone nada y RELEVA repregunta. La extracción de varios datos de una frase libre
  ("una mujer con un chico y tres bolsos") es el trabajo del intérprete con IA de la próxima etapa,
  con el mismo contrato.
Cambiar de proveedor es escribir un adaptador y cambiar una línea en `apps/mobile/App.tsx`.

**Comandos de voz con palabra de activación.** `parseCommand` exige empezar con "RELEVA" para no
disparar acciones por conversaciones de fondo ("RELEVA, tomá latitud", "RELEVA, repetí",
"RELEVA, cancelá el punto", "RELEVA, sincronizá", "RELEVA, terminá el recorrido").

**Offline primero.** Todo relevamiento se escribe primero en SQLite del dispositivo, en una cola
(outbox) con UUID generado en el celular. La sincronización reintenta con backoff y el servidor
es idempotente por ese UUID: reenviar dos veces no duplica. Nada se borra localmente hasta que
el servidor confirma.

**Sesiones que se cortan en el acto.** El token de acceso dura 15 minutos, pero en cada request
se verifica el estado actual del usuario: si se lo desactiva, se le cambia el rol o se desactiva
su cliente, pierde el acceso inmediatamente. Los refresh tokens rotan y su reutilización revoca
todas las sesiones del usuario. El límite de intentos de login es por cuenta (no solo por IP) y
la API solo confía en la cantidad de proxies configurada (`TRUST_PROXY_HOPS`).

**Auditoría inmutable.** `audit_log` es solo-inserción (un trigger impide UPDATE/DELETE).
Se registra quién, qué entidad, qué acción, cuándo y desde qué cliente.

**Privacidad.** No hay fotos de personas, ni reconocimiento facial, ni biometría, ni campos para
identificar personas entre relevamientos. La unidad es el **punto** (un lugar) y la **situación**
observada, no la persona.

## 4. Modelo de datos

```
clients ─┬─ organizations
         ├─ users (rol) ── project_members
         └─ projects ─┬─ zones (MultiPolygon)
                      ├─ routes / recorridos (LineString, relevador, estado)
                      ├─ questionnaires ── questionnaire_versions (JSON, publicado = inmutable)
                      └─ points (geography Point, zona calculada)
                           └─ surveys / relevamientos (versión de cuestionario, UUID offline)
                                ├─ survey_facts   (campo, valor, origen, estado, frase original)
                                └─ survey_utterances (transcripción para auditoría)
audit_log (solo inserción)
refresh_tokens
```

**Punto vs relevamiento.** Un *punto* es un lugar. Cada vez que se releva ese lugar se crea un
*relevamiento* nuevo. Así el punto conserva su historial. Al sincronizar, si la ubicación cae a
menos de `dedupe_radius_m` (configurable por proyecto, 25 m por defecto) de un punto existente
del mismo proyecto, el relevamiento se asocia a ese punto en vez de crear otro.

**Estados de un dato** (`survey_facts.status`):
`mentioned` (dicho por el relevador) · `extracted` (estructurado por el intérprete) ·
`confirmed` (confirmado por el relevador) · `unknown` (no se sabe; explícito, no inventado).

## 5. Roles

| Rol            | Alcance                                                         |
|----------------|-----------------------------------------------------------------|
| `super_admin`  | Todo el sistema, todos los clientes.                            |
| `client_admin` | Su cliente: usuarios, proyectos, zonas, recorridos, cuestionarios. |
| `analyst`      | Su cliente, solo lectura: mapa, indicadores, fichas (Gobierno). |
| `surveyor`     | Relevador: proyectos asignados, crear recorridos y relevamientos. |

Los permisos están declarados en `@releva/core` (`permissions.ts`) y se aplican en la API.

## 6. Máquina de estados de la app

```
INICIO → RECORRIDO ⇄ VEHICULO_EN_MOVIMIENTO / VEHICULO_DETENIDO
VEHICULO_DETENIDO → CAPTURANDO_UBICACION → PUNTO_ACTIVO
PUNTO_ACTIVO → PREGUNTANDO → ESCUCHANDO → PROCESANDO_RESPUESTA
     → (faltan datos) PREGUNTANDO  |  (completo) CONFIRMANDO
CONFIRMANDO → (sí) GUARDANDO → PUNTO_COMPLETADO → RECORRIDO
            → (no) PREGUNTANDO
SINCRONIZANDO y ERROR alcanzables desde los estados que corresponden.
```

Regla de seguridad: `CAPTURANDO_UBICACION` solo es alcanzable desde `VEHICULO_DETENIDO`.
Si durante un punto activo se detecta movimiento, la entrevista se pausa (el punto queda guardado
localmente) y se retoma al detenerse. La transición está implementada como función pura y
testeada: no depende de la UI.

## 7. Revisión de seguridad de esta etapa

Una revisión independiente del backend no encontró forma de cruzar datos entre clientes ni
inyección SQL. Encontró y se corrigieron: un relevador podía iniciar recorridos de proyectos no
asignados; la idempotencia del sync podía revelar ids de otro proyecto (ahora se verifica el
proyecto primero y el UUID es único por cliente); límite de login evadible rotando
`X-Forwarded-For`; un admin de cliente podía modificar a otro admin; un cambio de rol no cortaba
la sesión; límites de tamaño/anidamiento en cuestionarios, geometrías y datos sincronizados.

Pendiente para producción: conectar la API con un rol de base de datos distinto del dueño de las
tablas (hoy `releva_app` es dueño; RLS está forzado igual, pero un rol separado agrega una barrera
más), mover el refresh token del panel web a una cookie httpOnly, y usar un proveedor de teselas
con acuerdo de uso en lugar de los servidores públicos de OpenStreetMap.

## 8. Qué queda para las próximas etapas

- Motor conversacional completo con un proveedor de IA real (el contrato ya está definido).
- STT real on-device o en la nube, y activación por palabra clave ("RELEVA, tomá latitud").
- Editor visual de cuestionarios (hoy: editor JSON con validación en vivo).
- Dashboards completos del panel de Gobierno (hoy: mapa, fichas e indicadores base genéricos).
- Carga de zonas por KML.
