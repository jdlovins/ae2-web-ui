FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY schema.sql ./
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8081
CMD ["node", "src/index.mjs"]
