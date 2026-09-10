# Stage 1: build the frontend from the tracked yarn.lock
FROM node:lts AS build
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY tsconfig.json ./
COPY public ./public
COPY src ./src
RUN yarn build

# Stage 2: serve the build with the bundled Express server.
# Set PROTO_ENDPOINT to a beacon node base URL to enable the /eth/* proxy (the app then
# connects through this server automatically); leave it unset to enter a node URL in the UI.
FROM node:lts-slim
WORKDIR /app
RUN corepack enable
COPY server/package.json server/yarn.lock ./server/
RUN cd server && yarn install --frozen-lockfile --production
COPY server/server.js ./server/
COPY --from=build /app/build ./build
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server/server.js"]
