FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_GATEWAY_URL=/models/v1
ENV VITE_GATEWAY_URL=${VITE_GATEWAY_URL}
# Login config is baked at build time (Vite inlines VITE_* into the bundle).
# Auth-off is only for local previews. Live deployment requires native PKCE
# and the exact HTTPS realm issuer. See services/ui/README.md.
ARG VITE_AUTH_ENABLED=
ARG VITE_KEYCLOAK_AUTHORITY=
ARG VITE_KEYCLOAK_CLIENT_ID=
ARG VITE_EMBEDDED=false
ENV VITE_AUTH_ENABLED=${VITE_AUTH_ENABLED} \
    VITE_KEYCLOAK_AUTHORITY=${VITE_KEYCLOAK_AUTHORITY} \
    VITE_KEYCLOAK_CLIENT_ID=${VITE_KEYCLOAK_CLIENT_ID} \
    VITE_EMBEDDED=${VITE_EMBEDDED}
RUN npm run build

FROM nginx:alpine AS runtime
ENV NGINX_ENVSUBST_FILTER=^POD_NAMESPACE$
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=builder /app/dist/ /usr/share/nginx/html/
EXPOSE 8080
