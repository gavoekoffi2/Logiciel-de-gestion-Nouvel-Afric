# Image Docker — pour héberger l'application sur Railway, Fly.io, un VPS, etc.
FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/nouvelafric.db

# Dépendances (couche mise en cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Code de l'application
COPY . .

# Dossier persistant pour la base de données
VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]
