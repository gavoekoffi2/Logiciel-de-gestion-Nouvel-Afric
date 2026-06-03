# Image Docker — pour héberger l'application (Render, Koyeb, Railway, Fly.io, VPS…).
# Les données sont stockées dans Turso : fournir TURSO_DATABASE_URL et
# TURSO_AUTH_TOKEN (ainsi que SESSION_SECRET) comme variables d'environnement.
FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Dépendances (couche mise en cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Code de l'application
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
