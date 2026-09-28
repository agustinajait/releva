-- Rol de aplicación: NO superusuario, para que Row Level Security aplique siempre.
CREATE ROLE releva_app LOGIN PASSWORD 'releva_app_dev';
GRANT ALL ON DATABASE releva TO releva_app;
\connect releva
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT ALL ON SCHEMA public TO releva_app;
