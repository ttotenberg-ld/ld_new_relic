FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY tracing.js index.js ./

EXPOSE 3002

CMD ["npm", "start"]
