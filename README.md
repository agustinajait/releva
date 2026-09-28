# RELEVA

Relevamiento territorial asistido por voz para equipos que recorren la calle en vehículo.
Una app Android conduce la entrevista; un panel web permite administrar y entender lo relevado.

> **Etapa 1 — base técnica.** Ver [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) para las decisiones.

```
packages/core   Dominio compartido: cuestionarios, reglas, máquina de estados, cola offline, contratos de voz/IA
apps/api        Backend (Node + Fastify) + migraciones PostgreSQL/PostGIS
apps/web        Panel web (React + Vite): Super Admin y Gobierno
apps/mobile     App Android (Expo / React Native)
infra           docker-compose con PostGIS
```

## Requisitos

- Node.js 20 o superior
- Docker (para la base de datos) — o PostgreSQL 16 con PostGIS 3 instalado
- Para la app: un celular Android o el emulador de Android Studio

## Puesta en marcha

```bash
# 1. Dependencias (una sola vez, desde la raíz)
npm install

# 2. Base de datos (PostgreSQL + PostGIS en el puerto 5432)
npm run db:up

# 3. Configuración de la API
cp apps/api/.env.example apps/api/.env
#   editar JWT_SECRET (generar con: openssl rand -base64 48)
export $(grep -v '^#' apps/api/.env | xargs)

# 4. Esquema y datos de demostración
npm run db:migrate
npm run db:seed

# 5. API (http://localhost:4000)
npm run dev:api

# 6. Panel web (http://localhost:5173), en otra terminal
npm run dev:web
```

### Usuarios de demostración

Contraseña de todos: `releva-demo-2026`

| Rol | Email | Qué ve |
|---|---|---|
| Super Admin | `super@releva.local` | Todo: clientes, organismos, usuarios, proyectos |
| Admin de cliente | `admin@demo.releva.local` | Administración de su cliente |
| Analista (Gobierno) | `gobierno@demo.releva.local` | Mapa, fichas de punto, indicadores |
| Relevador | `relevador@demo.releva.local` | Solo la app móvil |

El seed crea un proyecto con dos zonas en CABA, un recorrido, el cuestionario de ejemplo publicado
y 8 relevamientos de demostración (uno repite un lugar, para ver el historial del punto).

## App Android

```bash
cd apps/mobile
# URL de la API vista desde el celular. En el emulador, 10.0.2.2 es tu computadora.
export EXPO_PUBLIC_API_URL=http://10.0.2.2:4000        # emulador
# export EXPO_PUBLIC_API_URL=http://192.168.x.x:4000   # celular en la misma red Wi-Fi

npx expo run:android        # compila e instala una build de desarrollo (requiere Android Studio / SDK)
```

Sin Android Studio, se puede compilar en la nube con EAS: `npx eas-cli@latest build -p android --profile development`.

> La app usa módulos nativos (SQLite, GPS, almacenamiento seguro), por eso necesita una build
> de desarrollo; no alcanza con Expo Go.

### Probar un relevamiento

1. Ingresar con `relevador@demo.releva.local`.
2. Elegir el proyecto y el recorrido.
3. En el emulador, usar **Simular detenido** (en un vehículo real, la detección es automática por GPS).
4. **Tomar ubicación** (o escribir `RELEVA, tomá latitud`). RELEVA dice "Latitud tomada" y pregunta.
5. Responder por escrito lo que diría el relevador, por ejemplo:
   `Hay una persona` → `No` → `Sí, una mochila` → `Sí, un perro` → `Sí`.
6. El punto se guarda en el teléfono y se sincroniza. Aparece en el mapa del panel web.

Probá también: **Simular en movimiento** en medio de la entrevista (se pausa y no deja relevar),
o cortar el Wi-Fi (se guarda offline y se sincroniza al volver la señal).

## Pruebas

```bash
# Todo (necesita la base levantada: npm run db:up)
npm test

# Por paquete
npm test -w @releva/core      # reglas, máquina de estados, cola offline, intérprete
npm test -w @releva/api       # integración contra PostGIS real: auth, roles, aislamiento, sync
npm test -w @releva/web       # panel
npm test -w @releva/mobile    # flujo completo del relevador con dispositivo simulado

npm run typecheck             # tipos en todos los paquetes
```

Las pruebas de la API recrean una base `releva_test`. Si tu PostgreSQL no es el de Docker,
configurá `TEST_ADMIN_URL` (superusuario) y `TEST_DATABASE_URL` (rol `releva_app`).

## Variables de entorno de la API

| Variable | Descripción | Por defecto |
|---|---|---|
| `DATABASE_URL` | Conexión con el rol `releva_app` | — |
| `JWT_SECRET` | Secreto de firma, mínimo 32 caracteres | — |
| `PORT` | Puerto HTTP | `4000` |
| `CORS_ORIGINS` | Orígenes permitidos del panel, separados por coma | `http://localhost:5173` |
| `TRUST_PROXY_HOPS` | Proxies de confianza delante de la API | `0` |
| `LOGIN_RATE_LIMIT` | Intentos de login por minuto por cuenta | `10` |
| `ACCESS_TOKEN_TTL` | Vida del token de acceso | `15m` |
| `REFRESH_TOKEN_DAYS` | Vida de la sesión | `30` |

## Privacidad

RELEVA no toma fotos de personas, no hace reconocimiento facial ni identificación biométrica,
y no intenta identificar personas entre relevamientos. La unidad de información es el **punto**
(un lugar) y la **situación** observada.
