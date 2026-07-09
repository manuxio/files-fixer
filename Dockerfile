# --- build the React client ---
FROM node:20-alpine AS client
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# --- runtime: Express serving API + built client ---
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY server/ ./server/
COPY scripts/ ./scripts/
COPY assets/ ./assets/
COPY --from=client /app/client/dist ./client/dist
EXPOSE 3000
CMD ["node", "server/index.js"]
