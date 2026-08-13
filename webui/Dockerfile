# --- build stage ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime stage: nginx serves the SPA + icons and reverse-proxies the API ---
FROM nginx:1.27-alpine
# Built SPA
COPY --from=build /app/dist /usr/share/nginx/html
# Item icon pack (PNGs named by itemid). These are gitignored and NOT built by
# `npm run build` — run `npm run icons` before `docker build`, or the image ships
# without icons and the app falls back to glyphs. See icons/README.md.
COPY icons/ /usr/share/nginx/html/icons/
# nginx config template (MOD_UPSTREAM substituted at container start)
COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker-entrypoint.sh /usr/local/bin/ae2-entrypoint.sh
RUN chmod +x /usr/local/bin/ae2-entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/ae2-entrypoint.sh"]
